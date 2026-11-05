-- SEC-042: un abono anulado es definitivo, y eso vive en la BD.
--
-- Hallazgo (revisión de DX-215, hallazgo 3): `payments` no impedía editar un
-- abono ya anulado. El trigger de `payment_promises` (DX-215) reabre un
-- compromiso CUMPLIDO solo si en la misma transacción se escribió un abono
-- anulado del paciente (la versión viva de la fila la escribió ella: xmin = su
-- xid). Con SQL directo como `dentalix_app`, un `UPDATE payments SET notes =
-- notes` sobre un abono anulado antiguo cumplía esa condición y reabría un
-- compromiso sin anular dinero real.
--
-- Cambios (una función y un trigger nuevos y el cuerpo de una función
-- existente; ninguna columna, índice ni dato cambia):
--   dx_payment_void_guard()   BEFORE INSERT | UPDATE | DELETE en `payments`:
--                      - INSERT con "voidedAt" o "deletedAt" no nulo:
--                        rechazado (un abono nace vigente).
--                      - UPDATE o DELETE de una fila con "voidedAt" O
--                        "deletedAt" no nulo: rechazado, sea cual sea la
--                        columna (se mira cada una por separado, sin CHECK:
--                        filas antiguas pueden tener solo una).
--                      - UPDATE de un abono vigente: "createdAt" no cambia
--                        (lo pone la BD en el INSERT, DX-226).
--                      - La anulación (vigente -> con "voidedAt"/"deletedAt")
--                        solo escribe deletedAt, voidedAt, voidedById,
--                        voidReason y updatedAt; importe, moneda, fechas y el
--                        resto quedan como estaban (así lo hace
--                        PrismaPaymentRepository.voidLine; comparación sobre
--                        to_jsonb de la fila, que cubre columnas futuras).
--                      - El superusuario pasa (purga administrativa, réplica y
--                        fixtures de test), como en el resto de las tablas
--                        financieras (dx_cash_is_superuser, DX-027).
--   dx_payment_promise_guard() (reemplaza el cuerpo de DX-215, mismo nombre y
--                      firma): además de lo de antes, el abono que reabre un
--                      compromiso tiene que haberse registrado ANTES de esta
--                      transacción ("createdAt" < inicio de la transacción, la
--                      misma fuente de hora que usa la columna). Sin esto, un
--                      abono de 0,01 insertado y anulado en la misma
--                      transacción reabría el compromiso sin anular dinero
--                      real.
--
-- Consecuencia para DX-215: una fila de `payments` con "voidedAt" no nulo y
-- xmin = la transacción actual solo puede ser la que se anuló en esta
-- transacción (no se reescribe una anulada ni se inserta una ya anulada), y
-- con el predicado de "createdAt" además existía antes de ella: es una
-- anulación real de dinero registrado antes, sin valor de sesión falseable.
--
-- Columnas escritas legítimamente DESPUÉS de anular: ninguna. La anulación de
-- la API (PrismaPaymentRepository.voidLine) escribe todo en un único UPDATE
-- ... WHERE deletedAt IS NULL; el número de factura externa, el congelado de
-- tasa y los barridos filtran deletedAt IS NULL; comprobante (DX-389),
-- imputaciones/bases (DX-399/413) y recibos viven en otras tablas.
--
-- Futuras migraciones con el owner SIN superusuario (Postgres gestionado): el
-- trigger también lo frena a él. Una migración que deba tocar abonos anulados
-- (un backfill, o una cascada ON UPDATE de una FK como currencies.code) tiene
-- que hacer ALTER TABLE payments DISABLE TRIGGER payments_void_immutable al
-- empezar y ENABLE TRIGGER al terminar, en la misma migración.
--
-- Bloqueos: CREATE TRIGGER toma SHARE ROW EXCLUSIVE en `payments` (frena las
-- escrituras, no las lecturas); lock_timeout acota la espera. search_path fijo
-- con pg_temp al final y catálogo calificado (SEC-032). Sin datos personales
-- en los mensajes.

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public.dx_payment_void_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF public.dx_cash_is_superuser() THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."voidedAt" IS NOT NULL OR NEW."deletedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Un abono no puede registrarse ya como abono anulado: nace vigente y solo se anula después (SEC-042)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."voidedAt" IS NOT NULL OR OLD."deletedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Un abono anulado es definitivo: no se puede modificar ni borrar (SEC-042)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'La fecha de alta de un abono no cambia (SEC-042)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Anulación: solo la marca de anulación; el resto del abono queda igual.
  IF (NEW."voidedAt" IS NOT NULL OR NEW."deletedAt" IS NOT NULL)
     AND (pg_catalog.to_jsonb(NEW) OPERATOR(pg_catalog.-)
            ARRAY['deletedAt', 'voidedAt', 'voidedById', 'voidReason', 'updatedAt'])
         IS DISTINCT FROM
         (pg_catalog.to_jsonb(OLD) OPERATOR(pg_catalog.-)
            ARRAY['deletedAt', 'voidedAt', 'voidedById', 'voidReason', 'updatedAt'])
  THEN
    RAISE EXCEPTION 'Al anular un abono solo se escribe la anulación: importe, moneda y fechas no cambian (SEC-042)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payments_void_immutable"
  BEFORE INSERT OR UPDATE OR DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION public.dx_payment_void_guard();

-- DX-215 + SEC-042: ver la cabecera.
CREATE OR REPLACE FUNCTION public.dx_payment_promise_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'payment_promises no admite %: un compromiso no se borra (DX-150)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Misma fuente de hora que el alta del abono (DX-226).
    NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    NEW."reopenedAt" := NULL;
    IF NEW."status" <> 'OPEN' THEN
      RAISE EXCEPTION 'Un compromiso nace abierto (DX-150)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: nada más que el estado, su hora de cierre y (al reabrir) la de
  -- reapertura.
  IF (NEW."id", NEW."tenantId", NEW."patientId", NEW."locationId", NEW."amount",
      NEW."currency", NEW."dueDate", NEW."createdById", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."tenantId", OLD."patientId", OLD."locationId", OLD."amount",
      OLD."currency", OLD."dueDate", OLD."createdById", OLD."createdAt")
  THEN
    RAISE EXCEPTION 'payment_promises es inalterable: un compromiso abierto solo pasa a cumplido o incumplido, una vez (DX-150)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- OPEN -> KEPT | BROKEN (DX-150), sin tocar la reapertura.
  IF OLD."status" = 'OPEN' AND NEW."status" IN ('KEPT', 'BROKEN')
     AND NEW."reopenedAt" IS NOT DISTINCT FROM OLD."reopenedAt"
  THEN
    RETURN NEW;
  END IF;

  -- KEPT -> OPEN | BROKEN (DX-215): solo en la transacción que anula un abono
  -- que contaba para él.
  IF OLD."status" = 'KEPT' AND NEW."status" IN ('OPEN', 'BROKEN')
     AND EXISTS (
       SELECT 1
         FROM public."payments" p
        WHERE p."tenantId" = OLD."tenantId"
          AND p."patientId" = OLD."patientId"
          AND p."currency" = OLD."currency"
          AND p."voidedAt" IS NOT NULL
          AND p."deletedAt" IS NOT NULL
          AND p."createdAt" >= OLD."createdAt"
          -- SEC-042: el abono existía antes de ESTA transacción (su alta la
          -- pone la BD con el inicio de la transacción, DX-226, y "createdAt"
          -- ya no cambia): uno insertado y anulado aquí mismo no cuenta.
          AND p."createdAt" < pg_catalog.timezone('UTC', pg_catalog.now())::pg_catalog.timestamp(3)
          AND p.xmin = pg_catalog.pg_current_xact_id()::xid
     )
  THEN
    -- Hora del servidor en UTC, sea cual sea la zona de la sesión (DX-226).
    NEW."reopenedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'payment_promises es inalterable: un compromiso abierto solo pasa a cumplido o incumplido, una vez; uno cumplido solo se reabre al anular el abono que lo cumplía (DX-150, DX-215)'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
