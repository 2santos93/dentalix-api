-- DX-247: vigencia de la anamnesis y confirmación «Sin cambios hoy».
--
-- Cambios:
--   tenants."anamnesisValidityMonths"  meses que vale la anamnesis (o su
--                       última confirmación) antes de salir «Anamnesis
--                       caducada» en la agenda y en la ficha. 12 por defecto
--                       (AAOM: al menos una vez al año). CHECK 1..60.
--   medical_history_reviews  quién confirmó, cuándo y en qué sede que la salud
--                       y la medicación del paciente no cambiaron desde la
--                       versión vigente. No copia datos clínicos: solo
--                       apunta a la versión confirmada. Append-only para la app
--                       (no hay ruta que la cambie ni la borre).
--
-- FK COMPUESTAS por tenant (SEC-004), DENTRO del CREATE TABLE (la tabla nace
-- vacía; DX-134): paciente de la MISMA clínica, y versión de la MISMA clínica y
-- del MISMO paciente (destino: mhv_tenant_patient_id_key, migración anterior).
--
-- Compatible hacia atrás: solo AÑADE (una columna con DEFAULT y una tabla
-- vacía). El código anterior no las conoce.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants"
  ADD COLUMN "anamnesisValidityMonths" INTEGER NOT NULL DEFAULT 12,
  ADD CONSTRAINT "tenants_anamnesis_validity_months_check"
    CHECK ("anamnesisValidityMonths" BETWEEN 1 AND 60);

CREATE TABLE "medical_history_reviews" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "medicalHistoryVersionId" UUID NOT NULL,
    "reviewedById" UUID NOT NULL,
    "locationId" UUID,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medical_history_reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "medical_history_reviews_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "medical_history_reviews_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "medical_history_reviews_version_fkey"
      FOREIGN KEY ("tenantId", "patientId", "medicalHistoryVersionId")
      REFERENCES "medical_history_versions"("tenantId", "patientId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);

-- La última confirmación de cada paciente (agenda por lote: DISTINCT ON por
-- paciente y fecha descendente). También el lado hijo de la FK del paciente.
CREATE INDEX "medical_history_reviews_tenant_patient_idx"
  ON "medical_history_reviews"("tenantId", "patientId", "reviewedAt" DESC);
-- Lado hijo de la FK de la versión.
CREATE INDEX "medical_history_reviews_tenant_version_idx"
  ON "medical_history_reviews"("tenantId", "medicalHistoryVersionId");

ALTER TABLE "medical_history_reviews" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "medical_history_reviews"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
ALTER TABLE "medical_history_reviews" FORCE ROW LEVEL SECURITY;

-- Inalterable (DX-038): reutiliza la función de la historia clínica.
CREATE TRIGGER "medical_history_reviews_immutable"
  BEFORE UPDATE OR DELETE ON "medical_history_reviews"
  FOR EACH ROW EXECUTE FUNCTION "dx_forbid_clinical_record_mutation"();
CREATE TRIGGER "medical_history_reviews_no_truncate"
  BEFORE TRUNCATE ON "medical_history_reviews"
  FOR EACH STATEMENT EXECUTE FUNCTION "dx_forbid_clinical_record_mutation"();

-- Hora del servidor de BD en cada confirmación (ni la app ni un INSERT por SQL
-- la eligen), en UTC aunque la sesión tenga otra zona (DX-226). search_path
-- fijo con pg_temp al final (SEC-032).
CREATE FUNCTION "dx_anamnesis_review_server_timestamp"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW."reviewedAt" := timezone('UTC', now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER "medical_history_reviews_server_timestamp"
  BEFORE INSERT ON "medical_history_reviews"
  FOR EACH ROW EXECUTE FUNCTION "dx_anamnesis_review_server_timestamp"();
