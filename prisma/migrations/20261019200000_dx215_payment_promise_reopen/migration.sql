-- DX-215 (BE-032): un compromiso de pago CUMPLIDO cuyo abono se anula vuelve a
-- ABIERTO (si su día no ha pasado en la zona de su sede) o pasa a INCUMPLIDO.
--
-- Cambios:
--   payment_promises."reopenedAt"  cuándo se reabrió por última vez (la pone el
--                      servidor de BD en UTC, DX-226). NULL si nunca.
--   dx_payment_promise_guard()     la máquina de estados append-only admite,
--                      además de OPEN -> KEPT | BROKEN, KEPT -> OPEN | BROKEN
--                      SOLO en la transacción que anula un abono que contaba
--                      para el compromiso: del mismo paciente y moneda,
--                      registrado desde el compromiso ("createdAt" de los dos:
--                      misma fuente de hora, la de la BD en UTC) y anulado por
--                      ESTA transacción (la versión viva de la fila la escribió
--                      ella: xmin = su xid). Fuera de eso, todo sigue igual:
--                      ninguna otra columna cambia, BROKEN no se reabre, no se
--                      borra. La app decide OPEN o BROKEN con la regla del
--                      compromiso (payment-promise-rule.ts) bajo el candado
--                      por paciente; aquí solo se exige que haya causa.
--
-- Compatible hacia atrás: solo AÑADE una columna nullable sin valor por
-- defecto (sin reescribir la tabla) y reemplaza el cuerpo de la función (mismo
-- nombre, firma y dueño). Ningún dato existente cambia: los compromisos que
-- quedaron CUMPLIDOS con un abono ya anulado antes de esta migración siguen
-- así (ver el informe de DX-215). El código anterior no escribe "reopenedAt"
-- ni pide la transición nueva.
--
-- search_path fijo con pg_temp al final y catálogo calificado (SEC-032): la
-- consulta a payments va calificada con public. y corre con el rol de quien
-- escribe (RLS FORCE de payments con su clínica fijada).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "payment_promises" ADD COLUMN "reopenedAt" TIMESTAMP(3);

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
