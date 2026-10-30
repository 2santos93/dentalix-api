-- DX-402: la tasa manual de un día anterior a «manual desde» sirve de tasa
-- de respaldo a los abonos pendientes de ese día sin tasa del proveedor. El
-- barrido que la congela deja un evento en el abono (UPDATE PAYMENT, reason
-- EXCHANGE_RATE_BACKUP, origin JOB) sin usuario: lo hace un trabajo
-- programado, como el cierre de compromisos de pago (DX-150).
--
-- Cambios:
--   audit_events_actor_check   admite actor NULL también en ese evento
--                     concreto (y solo en él), con el abono como recurso.
--
-- Compatible hacia atrás: solo cambia un CHECK por otro MÁS PERMISIVO (las
-- filas que pasaban el anterior pasan este). El código anterior no escribe
-- ese evento. No hay tabla ni columna nueva.
--
-- Bloqueo: el DROP/ADD CONSTRAINT toma ACCESS EXCLUSIVE sobre audit_events
-- (y sus particiones) hasta el COMMIT, sin reescribir; NOT VALID + VALIDATE
-- (SHARE UPDATE EXCLUSIVE) recorre las filas sin bloquear escrituras más de
-- lo necesario. lock_timeout evita quedar encolado tras una transacción
-- larga (mismo molde que DX-150 y DX-099).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_actor_check";
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_check"
  CHECK (
    "actorUserId" IS NOT NULL
    OR "action" = 'LOGIN_FAILED'
    -- IS TRUE: un CHECK que da NULL PASA.
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'PATIENT'
        AND "actorRole" IS NULL
        AND "resourceId" = "patientId"
        AND "metadata" ->> 'reason' = 'REMINDER_OPT_OUT'
        AND "metadata" ->> 'origin' IN ('LINK', 'MESSAGE')) IS TRUE
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'PAYMENT_PROMISE'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'JOB'
        AND "metadata" ->> 'reason' IN ('PROMISE_KEPT', 'PROMISE_BROKEN')) IS TRUE
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'MEDICAL_HISTORY_SUBMISSION'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'LINK'
        AND "metadata" ->> 'reason' = 'ANAMNESIS_SUBMITTED') IS TRUE
    OR ("action" = 'CREATE'
        AND "resourceType" = 'DATA_CONSENT'
        AND "actorRole" IS NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'LINK'
        AND "metadata" ->> 'reason' = 'ANAMNESIS_LINK') IS TRUE
    -- DX-402: el barrido congeló una tasa de respaldo en un abono.
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'PAYMENT'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'JOB'
        AND "metadata" ->> 'reason' = 'EXCHANGE_RATE_BACKUP') IS TRUE
  ) NOT VALID;
ALTER TABLE "audit_events" VALIDATE CONSTRAINT "audit_events_actor_check";
