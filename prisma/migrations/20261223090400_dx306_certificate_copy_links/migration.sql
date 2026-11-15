-- DX-306 (segunda parte): «Enviar por WhatsApp» la copia de un certificado
-- (justificante o reposo) al paciente, por un enlace caducable (30 días por
-- defecto) con el token de los enlaces públicos (DX-443/DX-468).
--
-- Cambios:
--   patient_certificates_tenant_id_key  único (tenantId, id): destino de la
--                     FK compuesta de los enlaces (SEC-004).
--   patient_certificate_copy_links  un enlace por envío. Guarda SOLO el
--                     sha256 del token (UNIQUE: la búsqueda pública es por
--                     hash, bajo la RLS de la clínica del host), su caducidad,
--                     a quién se envió (enmascarado), quién lo envió y cuándo
--                     se invalidó (al reenviar o al archivar al paciente,
--                     DX-461). FK compuestas al certificado y al paciente.
--                     Mismo molde que prescription_copy_links: RLS FORCE,
--                     trigger de inmutabilidad, sin DELETE.
--   patient_certificate_copy_links_live_key  único PARCIAL: como mucho un
--                     enlace vivo por certificado.
--   audit_events_actor_check  la UNIÓN del de 20261222110100 (DX-468) y la
--                     apertura y la descarga de la copia (VIEW/EXPORT de
--                     PATIENT_CERTIFICATE, origen PUBLIC_LINK, sin actor).
--                     NOT VALID; su VALIDATE va en 20261223090500.
--
-- Compatible hacia atrás: tabla nueva, un índice único sobre la clave primaria
-- más el tenant (siempre único) y un CHECK de auditoría MÁS PERMISIVO.

SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX "patient_certificates_tenant_id_key"
  ON "patient_certificates"("tenantId", "id");

CREATE TABLE "patient_certificate_copy_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "certificateId" UUID NOT NULL,
    "destinationMasked" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "patient_certificate_copy_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "patient_certificate_copy_links_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El certificado y el paciente de la MISMA clínica.
    CONSTRAINT "patient_certificate_copy_links_certificate_fkey"
      FOREIGN KEY ("tenantId", "certificateId")
      REFERENCES "patient_certificates"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_certificate_copy_links_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId")
      REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_certificate_copy_links_created_by_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "patient_certificate_copy_links_destination_check"
      CHECK (char_length("destinationMasked") BETWEEN 1 AND 320),
    -- sha256 en hex: nunca el token en claro.
    CONSTRAINT "patient_certificate_copy_links_token_hash_check"
      CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "patient_certificate_copy_links_expiry_check"
      CHECK ("expiresAt" > "createdAt")
);

CREATE UNIQUE INDEX "patient_certificate_copy_links_token_hash_key"
  ON "patient_certificate_copy_links"("tokenHash");
-- Como mucho UN enlace vivo por certificado.
CREATE UNIQUE INDEX "patient_certificate_copy_links_live_key"
  ON "patient_certificate_copy_links"("tenantId", "certificateId")
  WHERE "revokedAt" IS NULL;
-- Los vivos de un paciente: archivar los cuenta y los invalida (DX-461).
CREATE INDEX "patient_certificate_copy_links_patient_live_idx"
  ON "patient_certificate_copy_links"("tenantId", "patientId")
  WHERE "revokedAt" IS NULL;
-- El último envío de un certificado (y lado hijo de la FK al certificado).
CREATE INDEX "patient_certificate_copy_links_sent_idx"
  ON "patient_certificate_copy_links"("tenantId", "certificateId", "createdAt");
-- Lado hijo de la FK al paciente.
CREATE INDEX "patient_certificate_copy_links_patient_idx"
  ON "patient_certificate_copy_links"("tenantId", "patientId");
CREATE INDEX "patient_certificate_copy_links_created_by_idx"
  ON "patient_certificate_copy_links"("createdById");

-- Un enlace solo cambia una vez: se invalida. Nada más cambia y no se borra.
CREATE FUNCTION public."patient_certificate_copy_links_guard"() RETURNS trigger
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
    RAISE EXCEPTION 'patient_certificate_copy_links: no se borra un enlace de la copia del certificado (DX-306)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'patient_certificate_copy_links: un enlace invalidado no cambia (DX-306)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."certificateId" IS DISTINCT FROM OLD."certificateId"
     OR NEW."destinationMasked" IS DISTINCT FROM OLD."destinationMasked"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'patient_certificate_copy_links: solo se marca invalidado (DX-306)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "patient_certificate_copy_links_guard"
  BEFORE UPDATE OR DELETE ON "patient_certificate_copy_links"
  FOR EACH ROW EXECUTE FUNCTION public."patient_certificate_copy_links_guard"();
CREATE TRIGGER "patient_certificate_copy_links_no_truncate"
  BEFORE TRUNCATE ON "patient_certificate_copy_links"
  FOR EACH STATEMENT EXECUTE FUNCTION public."patient_certificate_copy_links_guard"();

ALTER TABLE "patient_certificate_copy_links" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_certificate_copy_links"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "patient_certificate_copy_links" FORCE ROW LEVEL SECURITY;

REVOKE DELETE, TRUNCATE ON "patient_certificate_copy_links" FROM dentalix_app;
GRANT SELECT, INSERT, UPDATE ON "patient_certificate_copy_links" TO dentalix_app;

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
    -- DX-306: el paciente (o el responsable de un menor) abre la copia de su
    -- certificado (VIEW) o descarga su PDF (EXPORT) desde el enlace caducable
    -- que le envió la clínica por WhatsApp. Solo ids y el motivo.
    OR ("action" IN ('VIEW', 'EXPORT')
        AND "resourceType" = 'PATIENT_CERTIFICATE'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND (("action" = 'VIEW' AND "metadata" ->> 'reason' = 'CERTIFICATE_COPY_OPENED')
          OR ("action" = 'EXPORT' AND "metadata" ->> 'reason' = 'CERTIFICATE_COPY_DOWNLOADED'))) IS TRUE
  ) NOT VALID;
