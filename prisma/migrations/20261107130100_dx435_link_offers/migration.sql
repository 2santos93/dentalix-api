-- DX-435: oferta de un hueco libre con enlace público (el primero que acepta
-- se queda la cita).
--
-- Cambios:
--   waitlist_offers."tokenHash"  sha256 del token de un solo uso (el texto
--                     plano viaja solo en el enlace), UNIQUE: la búsqueda
--                     pública es por hash, bajo la RLS de la clínica del host.
--   waitlist_offers."expiresAt"  cuándo deja de valer el enlace (inicio del
--                     hueco o antes).
--   waitlist_offers_link_check   los canales con enlace llevan token y
--                     caducidad; los demás, ninguno de los dos.
--   waitlist_offers_tenant_provider_slot_pending_idx  índice PARCIAL de las
--                     ofertas pendientes de un hueco de un profesional (al
--                     aceptar se pasan a TAKEN_BY_OTHER y el panel las cuenta).
--   audit_events_actor_check     admite actor NULL en los eventos del enlace
--                     de la oferta (UPDATE de WAITLIST_OFFER, origen
--                     PUBLIC_LINK, reason SLOT_OFFER_*) y en la cita que
--                     crea o adelanta al aceptarla (CREATE/UPDATE de
--                     APPOINTMENT, reason SLOT_OFFER_ACCEPTED), y solo en ellos.
--
-- Compatible hacia atrás: columnas NULL sin default (sin reescritura), un
-- CHECK que las filas existentes cumplen (canales WA_ME/PHONE sin token), un
-- índice y un CHECK de auditoría MÁS PERMISIVO. El código anterior no escribe
-- las columnas nuevas.
--
-- Bloqueo: los ADD COLUMN y los ADD CONSTRAINT toman ACCESS EXCLUSIVE un
-- instante. waitlist_offers es pequeña (ofertas de recepción) y su CHECK se
-- valida aquí mismo; el de audit_events va NOT VALID y su VALIDATE en la
-- migración siguiente (20261107130200), con SHARE UPDATE EXCLUSIVE (molde de
-- DX-361). lock_timeout evita quedar encolado tras una transacción larga.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "waitlist_offers" ADD COLUMN "tokenHash" TEXT;
ALTER TABLE "waitlist_offers" ADD COLUMN "expiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "waitlist_offers_token_hash_key"
  ON "waitlist_offers"("tokenHash");

ALTER TABLE "waitlist_offers" ADD CONSTRAINT "waitlist_offers_link_check"
  CHECK (
    ("channel" IN ('LINK_WA_ME', 'LINK_EMAIL'))
      = ("tokenHash" IS NOT NULL AND "expiresAt" IS NOT NULL)
    AND ("tokenHash" IS NULL) = ("expiresAt" IS NULL)
  );

CREATE INDEX "waitlist_offers_tenant_provider_slot_pending_idx"
  ON "waitlist_offers"("tenantId", "providerId", "slotStart")
  WHERE "outcome" = 'PENDING';

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
  ) NOT VALID;

