-- Historia clínica estructurada: `medical_history_versions` pasa de texto
-- libre por campo a listas/objetos JSON versionados + banderas de seguridad
-- (safetyFlags/hasCriticalAlert, calculadas en el dominio vía
-- deriveSafetyFlags) para poder renderizar alertas críticas sin parsear
-- texto. `patients` gana consentimiento (Ley 1581), identificación ampliada
-- y contacto de emergencia/acudiente.

-- 1) Nuevas columnas estructuradas + banderas.
ALTER TABLE "medical_history_versions"
  ADD COLUMN "conditions" JSONB,
  ADD COLUMN "dentalHistory" JSONB,
  ADD COLUMN "surgeries" JSONB,
  ADD COLUMN "vitalSigns" JSONB,
  ADD COLUMN "familyHistory" TEXT,
  ADD COLUMN "safetyFlags" JSONB,
  ADD COLUMN "hasCriticalAlert" BOOLEAN NOT NULL DEFAULT false;

-- 2) Preservar el texto libre legado dentro de `notes` (medico-legal: no se
--    pierde nada) antes de reusar los nombres de columna.
UPDATE "medical_history_versions" SET "notes" = trim(both E'\n' from
  concat_ws(E'\n',
    NULLIF("notes", ''),
    CASE WHEN COALESCE("allergies", '') <> '' THEN '[Alergias] ' || "allergies" END,
    CASE WHEN COALESCE("chronicConditions", '') <> '' THEN '[Condiciones] ' || "chronicConditions" END,
    CASE WHEN COALESCE("currentMedications", '') <> '' THEN '[Medicamentos] ' || "currentMedications" END,
    CASE WHEN COALESCE("habits", '') <> '' THEN '[Hábitos] ' || "habits" END,
    CASE WHEN COALESCE("medicalAlerts", '') <> '' THEN '[Alertas] ' || "medicalAlerts" END
  ));

-- 3) Dropear las columnas de texto viejas y recrearlas como JSONB
--    (allergies/medications/habits reusan el nombre con tipo nuevo).
ALTER TABLE "medical_history_versions"
  DROP COLUMN "allergies",
  DROP COLUMN "chronicConditions",
  DROP COLUMN "currentMedications",
  DROP COLUMN "habits",
  DROP COLUMN "medicalAlerts";

ALTER TABLE "medical_history_versions"
  ADD COLUMN "allergies" JSONB,
  ADD COLUMN "medications" JSONB,
  ADD COLUMN "habits" JSONB;

-- 4) Índice para el banner de alertas.
CREATE INDEX "medical_history_versions_tenantId_hasCriticalAlert_idx"
  ON "medical_history_versions" ("tenantId", "hasCriticalAlert");

-- 5) Patients: consentimiento (Ley 1581), identificación ampliada y
--    contacto de emergencia/acudiente. Sin backfill (columnas nuevas). No
--    hay que tocar RLS: las políticas ya están a nivel de tabla y aplican
--    a las columnas nuevas.
ALTER TABLE "patients"
  ADD COLUMN "dataConsentAccepted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "dataConsentAt" TIMESTAMP(3),
  ADD COLUMN "dataConsentPolicyVersion" TEXT,
  ADD COLUMN "maritalStatus" TEXT,
  ADD COLUMN "occupation" TEXT,
  ADD COLUMN "insurerEps" TEXT,
  ADD COLUMN "physicianName" TEXT,
  ADD COLUMN "physicianPhone" TEXT,
  ADD COLUMN "emergencyContactName" TEXT,
  ADD COLUMN "emergencyContactRelationship" TEXT,
  ADD COLUMN "emergencyContactPhone" TEXT,
  ADD COLUMN "guardianName" TEXT,
  ADD COLUMN "guardianDocNumber" TEXT;
