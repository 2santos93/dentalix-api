-- DX-361: la confirmación de cita por enlace queda en la auditoría. Los
-- eventos del personal (generar o reenviar el enlace) llevan usuario y no
-- tocan la BD; la respuesta del paciente desde el enlace (UPDATE APPOINTMENT,
-- origin LINK, reason CONFIRMATION_LINK_CONFIRMED / _CANCELLED /
-- _CALL_REQUESTED) va SIN actor, como los pasos de la firma a distancia
-- (DX-243).
--
-- Cambios:
--   audit_events_actor_check   admite actor NULL también en esos tres eventos
--                     concretos (y solo en ellos), con la cita como recurso y
--                     su paciente resuelto.
--
-- Sin cambios de enum: APPOINTMENT y UPDATE ya existen; el `reason` es texto
-- de la metadata. Sin índice nuevo: el registro filtra por tenant, fecha,
-- paciente, actor, acción y recurso, ya indexados.
--
-- Compatible hacia atrás: solo cambia un CHECK por otro MÁS PERMISIVO (las
-- filas que pasaban el anterior pasan este). El código anterior no escribe
-- esos eventos. No hay tabla ni columna nueva.
--
-- Bloqueo: el DROP/ADD CONSTRAINT toma ACCESS EXCLUSIVE sobre audit_events
-- (y sus particiones) hasta el COMMIT, pero NOT VALID no recorre filas, así
-- que dura milisegundos. El VALIDATE va en la migración siguiente
-- (20261107100100), en su propia transacción con SHARE UPDATE EXCLUSIVE: lee
-- la tabla sin bloquear la escritura de auditoría (molde de DX-390).
-- lock_timeout evita quedar encolado tras una transacción larga.

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
    -- DX-243: el paciente abre el enlace de firma, pide el código, lo
    -- verifica (o lo bloquea al fallar 5 veces) y firma.
    OR ("resourceType" = 'SIGNATURE_REQUEST'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'LINK'
        AND (("action" = 'VIEW' AND "metadata" ->> 'reason' = 'SIGNATURE_LINK_OPENED')
          OR ("action" = 'SEND' AND "metadata" ->> 'reason' = 'SIGNATURE_CODE_SENT')
          OR ("action" = 'UPDATE' AND "metadata" ->> 'reason' IN ('SIGNATURE_CODE_VERIFIED', 'SIGNATURE_LINK_LOCKED'))
          OR ("action" = 'SIGN' AND "metadata" ->> 'reason' = 'SIGNATURE_PATIENT_SIGNED'))) IS TRUE
    -- DX-361: el paciente confirma, cancela o pide que lo llamen desde el
    -- enlace de confirmación de la cita.
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'APPOINTMENT'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'LINK'
        AND "metadata" ->> 'reason' IN ('CONFIRMATION_LINK_CONFIRMED',
                                        'CONFIRMATION_LINK_CANCELLED',
                                        'CONFIRMATION_LINK_CALL_REQUESTED')) IS TRUE
  ) NOT VALID;
