-- DX-422: PDF firmado de un consentimiento firmado a distancia, generado en
-- el servidor y archivado en los documentos del paciente (DX-151).
--
-- `signed_consent_pdfs` es el ESTADO de la generación (uno por
-- consentimiento): PENDING mientras la cola (DX-085) lo genera o reintenta,
-- READY con el documento archivado (inalterable por el trigger de DX-151) o
-- FAILED si se agotaron los intentos. La ficha lo lee para «Descargar PDF» o
-- para decir que falló. No guarda nada clínico: solo ids, contadores y el
-- código técnico del último error.
--
-- Aditiva: tabla y enum nuevos; ninguna tabla existente cambia. Las FK van
-- dentro del CREATE TABLE (la tabla nace vacía: DX-134 no aplica).

SET LOCAL lock_timeout = '5s';

CREATE TYPE "SignedConsentPdfStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

CREATE TABLE "signed_consent_pdfs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "consentId" UUID NOT NULL,
    "status" "SignedConsentPdfStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "documentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signed_consent_pdfs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "signed_consent_pdfs_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "signed_consent_pdfs_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El consentimiento, de la MISMA clínica y del MISMO paciente.
    CONSTRAINT "signed_consent_pdfs_consent_fkey"
      FOREIGN KEY ("tenantId", "consentId", "patientId")
      REFERENCES "patient_consents"("tenantId", "id", "patientId")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El documento archivado, de la MISMA clínica.
    CONSTRAINT "signed_consent_pdfs_document_fkey"
      FOREIGN KEY ("tenantId", "documentId") REFERENCES "patient_documents"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Listo ⇔ con documento.
    CONSTRAINT "signed_consent_pdfs_ready_check"
      CHECK (("status" = 'READY') = ("documentId" IS NOT NULL)),
    CONSTRAINT "signed_consent_pdfs_attempts_check"
      CHECK ("attempts" BETWEEN 0 AND 1000),
    -- Código técnico (p. ej. `STORAGE_ERROR`), nunca un mensaje con datos.
    CONSTRAINT "signed_consent_pdfs_error_check"
      CHECK ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
);

-- Uno por consentimiento (y lado hijo de la FK al consentimiento).
CREATE UNIQUE INDEX "signed_consent_pdfs_consent_key"
  ON "signed_consent_pdfs"("tenantId", "consentId", "patientId");
CREATE INDEX "signed_consent_pdfs_patient_idx"
  ON "signed_consent_pdfs"("tenantId", "patientId");
-- Un documento archiva un solo consentimiento (y lado hijo de su FK).
CREATE UNIQUE INDEX "signed_consent_pdfs_document_key"
  ON "signed_consent_pdfs"("tenantId", "documentId");

-- Un PDF archivado no cambia: una fila READY queda congelada. Las demás solo
-- cambian de estado, contadores y error (ni consentimiento ni paciente).
CREATE FUNCTION public."signed_consent_pdfs_guard"() RETURNS trigger
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
    RAISE EXCEPTION 'signed_consent_pdfs: no se borra el estado del PDF firmado (DX-422)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" = 'READY' THEN
    RAISE EXCEPTION 'signed_consent_pdfs: un PDF firmado archivado es inalterable (DX-422)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."consentId" IS DISTINCT FROM OLD."consentId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'signed_consent_pdfs: no cambia de consentimiento (DX-422)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW."updatedAt" := pg_catalog.timezone('utc', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER "signed_consent_pdfs_guard"
  BEFORE UPDATE OR DELETE ON "signed_consent_pdfs"
  FOR EACH ROW EXECUTE FUNCTION public."signed_consent_pdfs_guard"();
CREATE TRIGGER "signed_consent_pdfs_no_truncate"
  BEFORE TRUNCATE ON "signed_consent_pdfs"
  FOR EACH STATEMENT EXECUTE FUNCTION public."signed_consent_pdfs_guard"();

ALTER TABLE "signed_consent_pdfs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "signed_consent_pdfs"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "signed_consent_pdfs" FORCE ROW LEVEL SECURITY;

-- Sin DELETE para la app (además del trigger), como los registros de DX-253.
REVOKE DELETE, TRUNCATE ON "signed_consent_pdfs" FROM dentalix_app;
GRANT SELECT, INSERT, UPDATE ON "signed_consent_pdfs" TO dentalix_app;
