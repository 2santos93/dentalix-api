-- DX-426 (DB-063): las líneas de un cobro dividido (DX-390) son del mismo
-- paciente y de la misma sede, el recibo es el de la línea 1 y las líneas se
-- anulan todas o ninguna. Hasta ahora solo lo garantizaba la app; la FK
-- compuesta payments_split_fkey solo ata la clínica.
--
-- Cambios (tres funciones y tres triggers nuevos; ninguna columna, índice ni
-- dato cambia):
--   dx_payment_split_guard()        BEFORE INSERT | UPDATE en `payments`
--                      (trigger payments_split_guard):
--                      - INSERT de una línea > 1: su paciente y su sede son
--                        los de la línea 1 (la FK ya exige que la línea 1
--                        exista y sea de la misma clínica).
--                      - UPDATE: tenantId, patientId, locationId, splitId y
--                        splitLine no cambian en una fila que es o pasaría a
--                        ser de un cobro dividido (ni se mueve una línea de
--                        sede o de cobro, ni la línea 1, ni se mete un abono
--                        suelto en un cobro después).
--   dx_payment_split_void_check()   AFTER INSERT | UPDATE OF deletedAt,
--                      voidedAt en `payments`, CONSTRAINT TRIGGER DEFERRABLE
--                      INITIALLY DEFERRED (payments_split_void_together): al
--                      COMMIT, ninguna línea viva comparte cobro con una
--                      anulada. Anular una sola línea, o añadir una viva a un
--                      cobro anulado, falla; anular todas en la misma
--                      transacción (PrismaPaymentRepository.softDelete: una
--                      UPDATE por línea) pasa.
--   dx_payment_receipt_split_head() BEFORE INSERT en `payment_receipts`
--                      (trigger payment_receipts_split_head): un cobro
--                      dividido tiene UN recibo, el de su línea 1.
--
-- Convivencia con SEC-042 (payments_void_immutable, BEFORE ... FOR EACH ROW):
-- los dos BEFORE son independientes (el de SEC-042 solo deja pasar la
-- anulación de un abono vigente y rechaza tocar uno anulado; este rechaza
-- mover una línea de paciente, sede o cobro, columnas que la anulación no
-- escribe) y no se pisan en ningún orden (disparan por nombre: payments_split_
-- guard antes que payments_void_immutable). El deferred corre al COMMIT, ya
-- con las anulaciones que SEC-042 dejó pasar. DX-463 (guarda de excedente) y
-- DX-389 (comprobante) no escriben estas columnas.
--
-- Superusuario: pasa los tres (purga administrativa, réplica y fixtures de
-- test), como el resto de las tablas financieras (dx_cash_is_superuser,
-- DX-027); el rol de la app no.
--
-- Futuras migraciones con el owner SIN superusuario que deban mover líneas de
-- sede o de paciente: ALTER TABLE payments DISABLE TRIGGER
-- payments_split_guard al empezar y ENABLE al terminar, en la misma migración.
--
-- Datos existentes: al final, el informe recorre cada clínica (con
-- app.current_tenant fijado: payments y payment_receipts tienen FORCE RLS y un
-- owner sin superusuario ni BYPASSRLS no vería ninguna fila) y la migración
-- FALLA con el recuento por clínica si hay un cobro dividido incoherente (otro
-- paciente o sede, línea sin línea 1, anulación a medias, recibo en una línea
-- > 1). Tampoco toca nada, así que reintentar tras corregir los datos es
-- seguro (`prisma migrate resolve --rolled-back
-- 20261121090000_dx426_split_payment_integrity` y de nuevo el deploy).
--
-- La FK payments_split_fkey SIGUE NOT VALID, a propósito (ver 20261105130200):
-- ya comprueba toda fila nueva o cambiada; VALIDATE CONSTRAINT con FORCE RLS en
-- la tabla hija y en la referenciada (la misma `payments`) y un owner sin
-- BYPASSRLS ve 0 filas y FALLA con datos válidos (DX-134), y la alternativa
-- (NO FORCE ... VALIDATE ... FORCE) retiene ACCESS EXCLUSIVE durante el
-- recorrido. El informe de abajo comprueba lo mismo (cada línea tiene su
-- línea 1 de su clínica) clínica a clínica, sin ese bloqueo.
--
-- Bloqueos: CREATE TRIGGER toma SHARE ROW EXCLUSIVE en `payments` y en
-- `payment_receipts` (frena las escrituras, no las lecturas) hasta el commit
-- de la migración, que dura lo que el informe (índice por clínica y cobro);
-- lock_timeout acota la espera. search_path fijo con pg_temp al final y
-- catálogo calificado (SEC-032). Sin datos personales en los mensajes.

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public.dx_payment_split_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  head_patient uuid;
  head_location uuid;
BEGIN
  IF public.dx_cash_is_superuser() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Suelto, o la línea 1 (splitId = id, payments_split_check): nada que
    -- comparar.
    IF NEW."splitId" IS NULL OR NEW."splitId" = NEW."id" THEN
      RETURN NEW;
    END IF;
    SELECT h."patientId", h."locationId"
      INTO head_patient, head_location
      FROM public."payments" h
     WHERE h."tenantId" = NEW."tenantId" AND h."id" = NEW."splitId";
    -- Sin línea 1 visible no hay con qué comparar: lo rechaza la FK.
    IF FOUND AND (NEW."patientId" <> head_patient OR NEW."locationId" <> head_location) THEN
      RAISE EXCEPTION 'Las líneas de un cobro dividido son del mismo paciente y de la misma sede que su línea 1 (DX-426)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF (OLD."splitId" IS NOT NULL OR NEW."splitId" IS NOT NULL)
     AND (NEW."tenantId", NEW."patientId", NEW."locationId", NEW."splitId", NEW."splitLine")
         IS DISTINCT FROM
         (OLD."tenantId", OLD."patientId", OLD."locationId", OLD."splitId", OLD."splitLine")
  THEN
    RAISE EXCEPTION 'Una línea de un cobro dividido no cambia de paciente, sede ni cobro (DX-426)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payments_split_guard"
  BEFORE INSERT OR UPDATE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION public.dx_payment_split_guard();

CREATE FUNCTION public.dx_payment_split_void_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF public.dx_cash_is_superuser() THEN
    RETURN NULL;
  END IF;
  -- Viva = sin "deletedAt" ni "voidedAt"; anulada = alguna de las dos (filas
  -- antiguas pueden tener solo una, como en SEC-042).
  IF EXISTS (
       SELECT 1 FROM public."payments" p
        WHERE p."tenantId" = NEW."tenantId" AND p."splitId" = NEW."splitId"
          AND p."deletedAt" IS NULL AND p."voidedAt" IS NULL
     )
     AND EXISTS (
       SELECT 1 FROM public."payments" p
        WHERE p."tenantId" = NEW."tenantId" AND p."splitId" = NEW."splitId"
          AND (p."deletedAt" IS NOT NULL OR p."voidedAt" IS NOT NULL)
     )
  THEN
    RAISE EXCEPTION 'Un cobro dividido se anula completo: todas sus líneas a la vez, en la misma transacción (DX-426)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "payments_split_void_together"
  AFTER INSERT OR UPDATE OF "deletedAt", "voidedAt" ON "payments"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."splitId" IS NOT NULL)
  EXECUTE FUNCTION public.dx_payment_split_void_check();

CREATE FUNCTION public.dx_payment_receipt_split_head() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF public.dx_cash_is_superuser() THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
       SELECT 1 FROM public."payments" p
        WHERE p."tenantId" = NEW."tenantId" AND p."id" = NEW."paymentId"
          AND p."splitId" IS NOT NULL AND p."splitId" <> p."id"
     )
  THEN
    RAISE EXCEPTION 'El recibo de un cobro dividido es el de su línea 1: las demás líneas no llevan recibo (DX-426)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_receipts_split_head"
  BEFORE INSERT ON "payment_receipts"
  FOR EACH ROW EXECUTE FUNCTION public.dx_payment_receipt_split_head();

-- Informe previo de los datos existentes (ver la cabecera).
DO $$
DECLARE
  t uuid;
  other_party integer;
  no_head integer;
  half_void integer;
  receipt_on_line integer;
  report text := '';
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);

    SELECT pg_catalog.count(*) INTO other_party
      FROM public."payments" l
      JOIN public."payments" h ON h."tenantId" = l."tenantId" AND h."id" = l."splitId"
     WHERE l."tenantId" = t AND l."splitId" IS NOT NULL AND l."splitId" <> l."id"
       AND (l."patientId" <> h."patientId" OR l."locationId" <> h."locationId");

    SELECT pg_catalog.count(*) INTO no_head
      FROM public."payments" l
     WHERE l."tenantId" = t AND l."splitId" IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public."payments" h
          WHERE h."tenantId" = l."tenantId" AND h."id" = l."splitId"
       );

    SELECT pg_catalog.count(*) INTO half_void FROM (
      SELECT p."splitId"
        FROM public."payments" p
       WHERE p."tenantId" = t AND p."splitId" IS NOT NULL
       GROUP BY p."splitId"
      HAVING pg_catalog.bool_or(p."deletedAt" IS NULL AND p."voidedAt" IS NULL)
         AND pg_catalog.bool_or(p."deletedAt" IS NOT NULL OR p."voidedAt" IS NOT NULL)
    ) s;

    SELECT pg_catalog.count(*) INTO receipt_on_line
      FROM public."payment_receipts" r
      JOIN public."payments" p ON p."tenantId" = r."tenantId" AND p."id" = r."paymentId"
     WHERE r."tenantId" = t AND p."splitId" IS NOT NULL AND p."splitId" <> p."id";

    IF other_party + no_head + half_void + receipt_on_line > 0 THEN
      report := report || pg_catalog.format(
        E'\n  clínica %s: %s líneas de otro paciente o sede, %s líneas sin línea 1, %s cobros anulados a medias, %s recibos en una línea > 1',
        t, other_party, no_head, half_void, receipt_on_line);
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('app.current_tenant', '', true);

  IF report <> '' THEN
    RAISE EXCEPTION 'DX-426: hay cobros divididos incoherentes; corrígelos y repite el deploy:%', report
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;
