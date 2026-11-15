-- DX-468: copia informativa de una receta emitida para el paciente, por un
-- enlace caducable (30 días por defecto). NO es la receta electrónica
-- oficial: para retirar el medicamento vale la impresa y firmada.
--
-- Cambios:
--   prescription_copy_links  un enlace por envío («Enviar al paciente» por
--                     email o WhatsApp). Guarda SOLO el sha256 del token
--                     (UNIQUE: la búsqueda pública es por hash, bajo la RLS de
--                     la clínica del host), su caducidad, el canal, a quién se
--                     envió (enmascarado), quién lo envió y cuándo se invalidó
--                     (al reenviar o al archivar al paciente, DX-461). FK
--                     compuestas por clínica a la receta y al paciente (SEC-004).
--                     Nada clínico. Mismo molde que signed_consent_pdf_links
--                     (DX-443): RLS FORCE, trigger de inmutabilidad, sin DELETE.
--   prescription_copy_links_live_key   índice único PARCIAL: como mucho un
--                     enlace vivo (sin invalidar) por receta; reenviar invalida
--                     el anterior en la misma transacción.
--   prescription_copy_links_patient_live_idx  índice PARCIAL de los vivos por
--                     paciente: archivar los cuenta y los invalida (DX-461).
--   prescription_copy_links_sent_idx  el último envío de cada receta (y lado
--                     hijo de la FK a la receta).
--   tenants."prescriptionPatientCopyFooter"  pie de la copia por clínica
--                     (Ajustes › Recetas); NULL = el de plataforma. CHECK
--                     1..300 caracteres NOT VALID (VALIDATE en 20261222110200).
--   audit_events_actor_check   la UNIÓN del de main (20261216090300, DX-467)
--                     y la apertura de la copia (VIEW de PRESCRIPTION, origen
--                     PUBLIC_LINK, reason PRESCRIPTION_COPY_OPENED, sin
--                     actor), y solo ella. NOT VALID; su VALIDATE va en
--                     20261222110200 (molde de DX-361 / DX-443 / DX-467).
--
-- Compatible hacia atrás: tabla nueva, una columna NULL sin DEFAULT (sin
-- reescritura) que el código anterior no lee, y un CHECK de auditoría MÁS
-- PERMISIVO. lock_timeout evita quedar encolado tras una transacción larga.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants"
  ADD COLUMN "prescriptionPatientCopyFooter" TEXT;
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_prescription_patient_copy_footer_check"
  CHECK ("prescriptionPatientCopyFooter" IS NULL
         OR char_length(btrim("prescriptionPatientCopyFooter")) BETWEEN 1 AND 300) NOT VALID;

CREATE TABLE "prescription_copy_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "prescriptionId" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "destinationMasked" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "prescription_copy_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "prescription_copy_links_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- La receta y el paciente de la MISMA clínica.
    CONSTRAINT "prescription_copy_links_prescription_fkey"
      FOREIGN KEY ("tenantId", "prescriptionId")
      REFERENCES "prescriptions"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "prescription_copy_links_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId")
      REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "prescription_copy_links_created_by_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "prescription_copy_links_channel_check"
      CHECK ("channel" IN ('EMAIL', 'WHATSAPP')),
    CONSTRAINT "prescription_copy_links_destination_check"
      CHECK (char_length("destinationMasked") BETWEEN 1 AND 320),
    -- sha256 en hex: nunca el token en claro.
    CONSTRAINT "prescription_copy_links_token_hash_check"
      CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "prescription_copy_links_expiry_check"
      CHECK ("expiresAt" > "createdAt")
);

CREATE UNIQUE INDEX "prescription_copy_links_token_hash_key"
  ON "prescription_copy_links"("tokenHash");
-- Como mucho UN enlace vivo por receta.
CREATE UNIQUE INDEX "prescription_copy_links_live_key"
  ON "prescription_copy_links"("tenantId", "prescriptionId")
  WHERE "revokedAt" IS NULL;
-- Los vivos de un paciente: archivar los cuenta y los invalida (DX-461).
CREATE INDEX "prescription_copy_links_patient_live_idx"
  ON "prescription_copy_links"("tenantId", "patientId")
  WHERE "revokedAt" IS NULL;
-- El último envío de una receta (y lado hijo de la FK a la receta).
CREATE INDEX "prescription_copy_links_sent_idx"
  ON "prescription_copy_links"("tenantId", "prescriptionId", "createdAt");
-- Lado hijo de la FK al paciente (el borrado de prueba y el deshacer de la
-- importación miran por paciente).
CREATE INDEX "prescription_copy_links_patient_idx"
  ON "prescription_copy_links"("tenantId", "patientId");
CREATE INDEX "prescription_copy_links_created_by_idx"
  ON "prescription_copy_links"("createdById");

-- Un enlace solo cambia una vez: se invalida. Nada más cambia y no se borra
-- (es el rastro de qué se envió, a quién y cuándo).
CREATE FUNCTION public."prescription_copy_links_guard"() RETURNS trigger
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
    RAISE EXCEPTION 'prescription_copy_links: no se borra un enlace de la copia de la receta (DX-468)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'prescription_copy_links: un enlace invalidado no cambia (DX-468)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."prescriptionId" IS DISTINCT FROM OLD."prescriptionId"
     OR NEW."channel" IS DISTINCT FROM OLD."channel"
     OR NEW."destinationMasked" IS DISTINCT FROM OLD."destinationMasked"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'prescription_copy_links: solo se marca invalidado (DX-468)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "prescription_copy_links_guard"
  BEFORE UPDATE OR DELETE ON "prescription_copy_links"
  FOR EACH ROW EXECUTE FUNCTION public."prescription_copy_links_guard"();
CREATE TRIGGER "prescription_copy_links_no_truncate"
  BEFORE TRUNCATE ON "prescription_copy_links"
  FOR EACH STATEMENT EXECUTE FUNCTION public."prescription_copy_links_guard"();

ALTER TABLE "prescription_copy_links" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "prescription_copy_links"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "prescription_copy_links" FORCE ROW LEVEL SECURITY;

REVOKE DELETE, TRUNCATE ON "prescription_copy_links" FROM dentalix_app;
GRANT SELECT, INSERT, UPDATE ON "prescription_copy_links" TO dentalix_app;

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
    -- DX-467: alguien sin sesión (una farmacia, el propio paciente) comprueba
    -- una receta por su código en la página pública: la consulta de una
    -- receta encontrada (válida o anulada) y la que encuentra el hash
    -- alterado. Solo ids y el motivo: el código no va en el evento.
    OR ("action" = 'VIEW'
        AND "resourceType" = 'PRESCRIPTION'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND "metadata" ->> 'reason' IN ('PRESCRIPTION_VERIFIED',
                                        'PRESCRIPTION_INTEGRITY_MISMATCH')) IS TRUE
    -- DX-468: el paciente (o el responsable de un menor) abre la copia de su
    -- receta desde el enlace caducable que le envió la clínica. Solo ids y el
    -- motivo: el token no va en el evento.
    OR ("action" = 'VIEW'
        AND "resourceType" = 'PRESCRIPTION'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND "metadata" ->> 'reason' = 'PRESCRIPTION_COPY_OPENED') IS TRUE
  ) NOT VALID;
