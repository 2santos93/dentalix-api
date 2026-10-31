-- DX-443: copia del PDF firmado al paciente por un enlace de un solo uso.
--
-- Cambios:
--   signed_consent_pdf_links    un enlace por envío de la copia (el
--                     automático al quedar READY y cada «Reenviar copia»).
--                     Guarda SOLO el sha256 del token (UNIQUE: la búsqueda
--                     pública es por hash, bajo la RLS de la clínica del
--                     host), su caducidad, quién lo envió (NULL = el envío
--                     automático), y cuándo se usó o se invalidó. Cuelga del
--                     estado del PDF (FK compuesta a signed_consent_pdfs: no
--                     hay enlace sin PDF del mismo consentimiento, paciente y
--                     clínica). Nada clínico.
--   signed_consent_pdf_links_live_key  índice único PARCIAL: como mucho un
--                     enlace vivo (sin usar ni invalidar) por consentimiento;
--                     reenviar invalida el anterior en la misma transacción.
--   signed_consent_pdf_links_sent_idx  el último envío de cada
--                     consentimiento (la ficha: «Copia enviada el …»).
--   signed_consent_pdfs."notifyPatient"  si al quedar READY se envía la copia
--                     por email (false en los generados por el barrido
--                     retroactivo: no se escribe a pacientes por documentos
--                     antiguos sin que la clínica lo pida).
--   (el barrido retroactivo busca consentimientos completos SIN fila en
--                     signed_consent_pdfs: el anti-join usa el índice único
--                     signed_consent_pdfs_consent_key, que ya existe.)
--   audit_events_actor_check   la UNIÓN del de main (20261107140100, DX-435)
--                     y la descarga pública (EXPORT de CONSENT, origen
--                     PUBLIC_LINK, reason SIGNED_PDF_COPY_DOWNLOADED, sin
--                     actor), y solo ella.
--
-- Compatible hacia atrás: tabla nueva, una columna NOT NULL con DEFAULT
-- constante (sin reescritura desde PG 11) que el código anterior no escribe,
-- y un CHECK de auditoría MÁS PERMISIVO (NOT VALID; su VALIDATE va en
-- 20261107160200, molde de DX-361). lock_timeout evita quedar encolado tras
-- una transacción larga.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "signed_consent_pdfs"
  ADD COLUMN "notifyPatient" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "signed_consent_pdf_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "consentId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    -- NULL: el envío automático al quedar READY.
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "signed_consent_pdf_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "signed_consent_pdf_links_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El PDF del MISMO consentimiento, paciente y clínica.
    CONSTRAINT "signed_consent_pdf_links_pdf_fkey"
      FOREIGN KEY ("tenantId", "consentId", "patientId")
      REFERENCES "signed_consent_pdfs"("tenantId", "consentId", "patientId")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "signed_consent_pdf_links_created_by_fkey"
      FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- sha256 en hex: nunca el token en claro.
    CONSTRAINT "signed_consent_pdf_links_token_hash_check"
      CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "signed_consent_pdf_links_expiry_check"
      CHECK ("expiresAt" > "createdAt"),
    -- Usado o invalidado, no las dos cosas.
    CONSTRAINT "signed_consent_pdf_links_state_check"
      CHECK ("usedAt" IS NULL OR "revokedAt" IS NULL)
);

CREATE UNIQUE INDEX "signed_consent_pdf_links_token_hash_key"
  ON "signed_consent_pdf_links"("tokenHash");
-- Como mucho UN enlace vivo por consentimiento.
CREATE UNIQUE INDEX "signed_consent_pdf_links_live_key"
  ON "signed_consent_pdf_links"("tenantId", "consentId")
  WHERE "usedAt" IS NULL AND "revokedAt" IS NULL;
-- El último envío de un consentimiento (y lado hijo de la FK al PDF).
CREATE INDEX "signed_consent_pdf_links_sent_idx"
  ON "signed_consent_pdf_links"("tenantId", "consentId", "patientId", "createdAt");
CREATE INDEX "signed_consent_pdf_links_created_by_idx"
  ON "signed_consent_pdf_links"("createdById");

-- Un enlace solo cambia una vez: se usa o se invalida. Nada más cambia y no
-- se borra (es el rastro de qué se envió y cuándo).
CREATE FUNCTION public."signed_consent_pdf_links_guard"() RETURNS trigger
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
    RAISE EXCEPTION 'signed_consent_pdf_links: no se borra un enlace de la copia (DX-443)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."usedAt" IS NOT NULL OR OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'signed_consent_pdf_links: un enlace usado o invalidado no cambia (DX-443)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."consentId" IS DISTINCT FROM OLD."consentId"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'signed_consent_pdf_links: solo se marca usado o invalidado (DX-443)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "signed_consent_pdf_links_guard"
  BEFORE UPDATE OR DELETE ON "signed_consent_pdf_links"
  FOR EACH ROW EXECUTE FUNCTION public."signed_consent_pdf_links_guard"();
CREATE TRIGGER "signed_consent_pdf_links_no_truncate"
  BEFORE TRUNCATE ON "signed_consent_pdf_links"
  FOR EACH STATEMENT EXECUTE FUNCTION public."signed_consent_pdf_links_guard"();

ALTER TABLE "signed_consent_pdf_links" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "signed_consent_pdf_links"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "signed_consent_pdf_links" FORCE ROW LEVEL SECURITY;

REVOKE DELETE, TRUNCATE ON "signed_consent_pdf_links" FROM dentalix_app;
GRANT SELECT, INSERT, UPDATE ON "signed_consent_pdf_links" TO dentalix_app;

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
  ) NOT VALID;
