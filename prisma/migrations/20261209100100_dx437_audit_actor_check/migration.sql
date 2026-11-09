-- DX-437: el paciente pide (o quita) «Avisarme si se libera un hueco antes»
-- desde el enlace de confirmación: UPDATE de APPOINTMENT sin usuario, origen
-- PUBLIC_LINK, reason CONFIRMATION_LINK_EARLIER_REQUESTED o
-- CONFIRMATION_LINK_EARLIER_CLEARED. El CHECK de actor de audit_events es la
-- UNIÓN del de main (20261107160100, DX-443) y esa escritura, y solo ella.
--
-- Más permisivo (NOT VALID; su VALIDATE va en 20261209100200, molde de
-- DX-361 / DX-435 / DX-443). lock_timeout evita quedar encolado tras una
-- transacción larga.

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
    -- DX-422: el trabajo del PDF firmado encontró un consentimiento cuyo
    -- hash no casa con lo guardado (no se archiva nada). Solo ids.
    OR ("action" = 'VIEW'
        AND "resourceType" = 'CONSENT'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'JOB'
        AND "metadata" ->> 'reason' = 'SIGNED_PDF_INTEGRITY_MISMATCH') IS TRUE
    -- DX-435: el paciente acepta o rechaza la oferta de hueco desde el
    -- enlace, el enlace caduca o el hueco se lo queda otro paciente.
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'WAITLIST_OFFER'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND "metadata" ->> 'reason' IN ('SLOT_OFFER_ACCEPTED',
                                        'SLOT_OFFER_DECLINED',
                                        'SLOT_OFFER_EXPIRED',
                                        'SLOT_OFFER_TAKEN_BY_OTHER')) IS TRUE
    -- DX-435: la cita que crea (CREATE) o adelanta (UPDATE) la aceptación
    -- desde el enlace, con el paciente de la cita.
    OR ("action" IN ('CREATE', 'UPDATE')
        AND "resourceType" = 'APPOINTMENT'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND "metadata" ->> 'reason' = 'SLOT_OFFER_ACCEPTED') IS TRUE
    -- DX-443: el paciente (o su responsable) descarga su copia del PDF
    -- firmado desde el enlace de un solo uso del email. Solo ids.
    OR ("action" = 'EXPORT'
        AND "resourceType" = 'CONSENT'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND "metadata" ->> 'reason' = 'SIGNED_PDF_COPY_DOWNLOADED') IS TRUE
    -- DX-437: el paciente pide (o quita) «Avisarme si se libera un hueco
    -- antes» desde el enlace de confirmación de la cita.
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'APPOINTMENT'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND "metadata" ->> 'reason' IN ('CONFIRMATION_LINK_EARLIER_REQUESTED',
                                        'CONFIRMATION_LINK_EARLIER_CLEARED')) IS TRUE
  ) NOT VALID;
