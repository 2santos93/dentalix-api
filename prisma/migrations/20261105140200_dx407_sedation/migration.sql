-- DX-407: hoja de sedación consciente en la evolución (porción 2 de DX-307).
--
-- Cambios (solo AÑADE: tipos, tablas y un índice único nuevos; nada existente
-- cambia de forma ni de datos):
--   SedationGrade, AsaClass, SedationVitalsPhase, SedationLevel,
--   SedationAgentKind, SedationRoute, SedationDoseUnit   tipos nuevos.
--   sedation_records                 valoración previa (una hoja por
--                                    evolución): grado, ASA, ayuno, Mallampati,
--                                    peso, talla, IMC, acompañante,
--                                    consentimiento y reversores por peso, con
--                                    la versión de la plantilla y el intervalo
--                                    de constantes con que se abrió.
--   sedation_checklists              checklist previo (uno por hoja): ítems de
--                                    la plantilla marcados, quién y cuándo.
--   sedation_agent_administrations   fármacos: N2O (% y flujo), oral u otro,
--                                    con dosis, vía, hora y quién.
--   sedation_vitals                  tomas de constantes por fase (basal,
--                                    intraoperatoria, alta).
--   sedation_discharges              egreso (uno por hoja): criterios o
--                                    Aldrete, constantes al alta, hora, a quién
--                                    se entrega, indicaciones, operador y
--                                    quien monitoriza.
--   patient_consents_tenant_patient_id_key   destino de la FK compuesta del
--                                    consentimiento de sedación (mismo
--                                    paciente y clínica). Tabla pequeña; el
--                                    índice no cambia ninguna fila.
--
-- Las cinco tablas son INALTERABLES como la evolución (DX-038): mismo trigger,
-- fecha del servidor, REVOKE de DELETE/TRUNCATE y corrección por adenda.
-- FK de tenantId explícita (DB-028), FK compuestas por clínica (SEC-004) y
-- RLS FORZADA por tenant. Grants: ALTER DEFAULT PRIVILEGES ya cubre a
-- dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "SedationGrade" AS ENUM ('MINIMAL', 'MODERATE');
CREATE TYPE "AsaClass" AS ENUM ('I', 'II', 'III', 'IV', 'V');
CREATE TYPE "SedationVitalsPhase" AS ENUM ('BASELINE', 'INTRA', 'DISCHARGE');
CREATE TYPE "SedationLevel" AS ENUM ('AWAKE', 'MINIMAL', 'MODERATE', 'DEEP');
CREATE TYPE "SedationAgentKind" AS ENUM ('NITROUS_OXIDE', 'ORAL', 'OTHER');
CREATE TYPE "SedationRoute" AS ENUM ('INHALED', 'ORAL', 'SUBLINGUAL', 'INTRANASAL', 'INTRAMUSCULAR', 'INTRAVENOUS', 'SUBMUCOSAL');
CREATE TYPE "SedationDoseUnit" AS ENUM ('MG', 'MCG', 'ML');

-- Destino de la FK compuesta (tenantId, patientId, consentId).
CREATE UNIQUE INDEX "patient_consents_tenant_patient_id_key"
  ON "patient_consents"("tenantId", "patientId", "id");

-- ---------------------------------------------------------------------------
-- 1. Hoja: valoración previa
-- ---------------------------------------------------------------------------
CREATE TABLE "sedation_records" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "clinicalEntryId" UUID NOT NULL,
    "locationId" UUID,
    "templateVersion" TEXT NOT NULL,
    "rulesVersion" TEXT NOT NULL,
    "vitalsIntervalMinutes" INTEGER NOT NULL,
    "grade" "SedationGrade" NOT NULL,
    "asaClass" "AsaClass",
    "asaEmergency" BOOLEAN NOT NULL DEFAULT false,
    "highAsaInterconsultation" TEXT,
    "highAsaJustification" TEXT,
    "fastingClearLiquidsHours" DECIMAL(3,1),
    "fastingSolidsHours" DECIMAL(3,1),
    "mallampati" SMALLINT,
    "weightKg" DECIMAL(4,1),
    "heightCm" DECIMAL(4,1),
    "bmi" DECIMAL(4,1),
    "naloxoneMg" DECIMAL(4,2),
    "flumazenilMg" DECIMAL(4,3),
    "escortName" TEXT,
    "escortRelationship" TEXT,
    "consentConfirmed" BOOLEAN NOT NULL,
    "consentId" UUID,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sedation_records_pkey" PRIMARY KEY ("id"),
    -- Mismos rangos que el DTO (defensa en profundidad ante un INSERT por SQL).
    CONSTRAINT "sedation_records_interval_range"
      CHECK ("vitalsIntervalMinutes" BETWEEN 1 AND 60),
    CONSTRAINT "sedation_records_fasting_range" CHECK (
      ("fastingClearLiquidsHours" IS NULL OR "fastingClearLiquidsHours" BETWEEN 0 AND 72)
      AND ("fastingSolidsHours" IS NULL OR "fastingSolidsHours" BETWEEN 0 AND 72)
    ),
    CONSTRAINT "sedation_records_mallampati_range"
      CHECK ("mallampati" IS NULL OR "mallampati" BETWEEN 1 AND 4),
    CONSTRAINT "sedation_records_body_range" CHECK (
      ("weightKg" IS NULL OR ("weightKg" > 0 AND "weightKg" < 400))
      AND ("heightCm" IS NULL OR "heightCm" BETWEEN 30 AND 250)
    ),
    -- El IMC lo calcula el servidor: existe si y solo si hay peso y talla.
    CONSTRAINT "sedation_records_bmi_derived"
      CHECK (("bmi" IS NULL) = ("weightKg" IS NULL OR "heightCm" IS NULL)),
    -- Los reversores por peso: existen si y solo si hay peso.
    CONSTRAINT "sedation_records_reversal_derived" CHECK (
      ("naloxoneMg" IS NULL) = ("weightKg" IS NULL)
      AND ("flumazenilMg" IS NULL) = ("weightKg" IS NULL)
      AND ("naloxoneMg" IS NULL OR "naloxoneMg" <= 2)
      AND ("flumazenilMg" IS NULL OR "flumazenilMg" <= 0.2)
    ),
    -- ASA III o más: interconsulta o justificación antes de sedar.
    CONSTRAINT "sedation_records_high_asa_reason" CHECK (
      "asaClass" IS NULL OR "asaClass" IN ('I', 'II')
      OR "highAsaInterconsultation" IS NOT NULL
      OR "highAsaJustification" IS NOT NULL
    ),
    CONSTRAINT "sedation_records_text_len" CHECK (
      ("highAsaInterconsultation" IS NULL OR char_length(btrim("highAsaInterconsultation")) BETWEEN 10 AND 1000)
      AND ("highAsaJustification" IS NULL OR char_length(btrim("highAsaJustification")) BETWEEN 10 AND 1000)
      AND ("escortName" IS NULL OR char_length(btrim("escortName")) BETWEEN 1 AND 120)
      AND ("escortRelationship" IS NULL OR char_length(btrim("escortRelationship")) BETWEEN 1 AND 60)
    )
);

-- Una hoja por evolución; también sirve el listado del paciente (prefijo) y
-- el lado hijo de la FK a la evolución.
CREATE UNIQUE INDEX "sedation_records_entry_key"
  ON "sedation_records"("tenantId", "patientId", "clinicalEntryId");
-- Destino de las FK compuestas de las tablas hijas.
CREATE UNIQUE INDEX "sedation_records_tenant_id_key" ON "sedation_records"("tenantId", "id");
-- Lado hijo de la FK a la sede (parcial: las evoluciones legacy no tienen).
CREATE INDEX "sedation_records_location_idx"
  ON "sedation_records"("tenantId", "locationId") WHERE "locationId" IS NOT NULL;
-- Lado hijo de la FK al consentimiento.
CREATE INDEX "sedation_records_consent_idx"
  ON "sedation_records"("tenantId", "patientId", "consentId") WHERE "consentId" IS NOT NULL;

ALTER TABLE "sedation_records" ADD CONSTRAINT "sedation_records_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sedation_records" ADD CONSTRAINT "sedation_records_tenantId_patientId_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sedation_records" ADD CONSTRAINT "sedation_records_tenantId_patientId_clinicalEntryId_fkey"
  FOREIGN KEY ("tenantId", "patientId", "clinicalEntryId") REFERENCES "clinical_entries"("tenantId", "patientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sedation_records" ADD CONSTRAINT "sedation_records_tenantId_locationId_fkey"
  FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sedation_records" ADD CONSTRAINT "sedation_records_tenantId_patientId_consentId_fkey"
  FOREIGN KEY ("tenantId", "patientId", "consentId") REFERENCES "patient_consents"("tenantId", "patientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sedation_records" ADD CONSTRAINT "sedation_records_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Checklist previo
-- ---------------------------------------------------------------------------
CREATE TABLE "sedation_checklists" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sedationRecordId" UUID NOT NULL,
    -- [{ code, label, checked }]: copia de los ítems de la plantilla.
    "items" JSONB NOT NULL,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sedation_checklists_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sedation_checklists_items_array" CHECK (jsonb_typeof("items") = 'array')
);

-- Uno por hoja (y lado hijo de la FK).
CREATE UNIQUE INDEX "sedation_checklists_record_key"
  ON "sedation_checklists"("tenantId", "sedationRecordId");

ALTER TABLE "sedation_checklists" ADD CONSTRAINT "sedation_checklists_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sedation_checklists" ADD CONSTRAINT "sedation_checklists_tenantId_sedationRecordId_fkey"
  FOREIGN KEY ("tenantId", "sedationRecordId") REFERENCES "sedation_records"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sedation_checklists" ADD CONSTRAINT "sedation_checklists_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. Fármacos
-- ---------------------------------------------------------------------------
CREATE TABLE "sedation_agent_administrations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sedationRecordId" UUID NOT NULL,
    "kind" "SedationAgentKind" NOT NULL,
    "drugName" TEXT,
    "dose" DECIMAL(8,2),
    "doseUnit" "SedationDoseUnit",
    "route" "SedationRoute" NOT NULL,
    "n2oPercent" SMALLINT,
    "flowLpm" DECIMAL(3,1),
    "administeredAt" TIMESTAMP(3) NOT NULL,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sedation_agent_administrations_pkey" PRIMARY KEY ("id"),
    -- N2O: % y flujo, inhalado y sin dosis; oral u otro: fármaco, dosis y
    -- unidad, sin % ni flujo; oral, por vía oral o sublingual.
    CONSTRAINT "sedation_agent_administrations_kind_shape" CHECK (
      ("kind" = 'NITROUS_OXIDE'
        AND "n2oPercent" BETWEEN 10 AND 70
        AND "flowLpm" > 0 AND "flowLpm" <= 15
        AND "route" = 'INHALED'
        AND "drugName" IS NULL AND "dose" IS NULL AND "doseUnit" IS NULL)
      OR ("kind" <> 'NITROUS_OXIDE'
        AND "drugName" IS NOT NULL AND char_length(btrim("drugName")) BETWEEN 1 AND 80
        AND "dose" > 0 AND "dose" <= 10000
        AND "doseUnit" IS NOT NULL
        AND "n2oPercent" IS NULL AND "flowLpm" IS NULL
        AND ("kind" <> 'ORAL' OR "route" IN ('ORAL', 'SUBLINGUAL')))
    )
);

-- Fármacos de una hoja en orden (y lado hijo de la FK).
CREATE INDEX "sedation_agent_administrations_record_idx"
  ON "sedation_agent_administrations"("tenantId", "sedationRecordId", "administeredAt");

ALTER TABLE "sedation_agent_administrations" ADD CONSTRAINT "sedation_agent_administrations_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sedation_agent_administrations" ADD CONSTRAINT "sedation_agent_administrations_tenantId_sedationRecordId_fkey"
  FOREIGN KEY ("tenantId", "sedationRecordId") REFERENCES "sedation_records"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sedation_agent_administrations" ADD CONSTRAINT "sedation_agent_administrations_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. Constantes
-- ---------------------------------------------------------------------------
CREATE TABLE "sedation_vitals" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sedationRecordId" UUID NOT NULL,
    "phase" "SedationVitalsPhase" NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL,
    "spo2" SMALLINT,
    "heartRate" SMALLINT,
    "systolic" SMALLINT,
    "diastolic" SMALLINT,
    "respiratoryRate" SMALLINT,
    "etco2" SMALLINT,
    "sedationLevel" "SedationLevel",
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sedation_vitals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sedation_vitals_range" CHECK (
      ("spo2" IS NULL OR "spo2" BETWEEN 50 AND 100)
      AND ("heartRate" IS NULL OR "heartRate" BETWEEN 20 AND 250)
      AND ("systolic" IS NULL OR "systolic" BETWEEN 40 AND 300)
      AND ("diastolic" IS NULL OR "diastolic" BETWEEN 20 AND 200)
      AND ("respiratoryRate" IS NULL OR "respiratoryRate" BETWEEN 2 AND 80)
      AND ("etco2" IS NULL OR "etco2" BETWEEN 0 AND 150)
    ),
    -- La TA va completa y la diastólica por debajo de la sistólica.
    CONSTRAINT "sedation_vitals_blood_pressure" CHECK (
      ("systolic" IS NULL) = ("diastolic" IS NULL)
      AND ("systolic" IS NULL OR "diastolic" < "systolic")
    )
);

-- Tomas de una hoja en orden (y lado hijo de la FK).
CREATE INDEX "sedation_vitals_record_idx"
  ON "sedation_vitals"("tenantId", "sedationRecordId", "takenAt");
-- Destino de la FK compuesta del egreso: sus constantes son de la MISMA hoja.
CREATE UNIQUE INDEX "sedation_vitals_tenant_record_id_key"
  ON "sedation_vitals"("tenantId", "sedationRecordId", "id");

ALTER TABLE "sedation_vitals" ADD CONSTRAINT "sedation_vitals_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sedation_vitals" ADD CONSTRAINT "sedation_vitals_tenantId_sedationRecordId_fkey"
  FOREIGN KEY ("tenantId", "sedationRecordId") REFERENCES "sedation_records"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sedation_vitals" ADD CONSTRAINT "sedation_vitals_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. Egreso
-- ---------------------------------------------------------------------------
CREATE TABLE "sedation_discharges" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sedationRecordId" UUID NOT NULL,
    -- [{ code, label, met }]: copia de los criterios de la plantilla.
    "criteria" JSONB NOT NULL,
    "aldreteScore" SMALLINT,
    "vitalsId" UUID NOT NULL,
    "dischargedAt" TIMESTAMP(3) NOT NULL,
    "handedOverToName" TEXT NOT NULL,
    "handedOverToRelationship" TEXT NOT NULL,
    "instructionsDelivered" BOOLEAN NOT NULL,
    "operatorId" UUID NOT NULL,
    "monitorId" UUID NOT NULL,
    "sameMonitorJustification" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sedation_discharges_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sedation_discharges_criteria_array" CHECK (jsonb_typeof("criteria") = 'array'),
    CONSTRAINT "sedation_discharges_aldrete_range"
      CHECK ("aldreteScore" IS NULL OR "aldreteScore" BETWEEN 0 AND 10),
    -- No hay egreso sin indicaciones entregadas.
    CONSTRAINT "sedation_discharges_instructions" CHECK ("instructionsDelivered"),
    CONSTRAINT "sedation_discharges_text_len" CHECK (
      char_length(btrim("handedOverToName")) BETWEEN 1 AND 120
      AND char_length(btrim("handedOverToRelationship")) BETWEEN 1 AND 60
      AND ("sameMonitorJustification" IS NULL OR char_length(btrim("sameMonitorJustification")) BETWEEN 10 AND 500)
    )
);

-- Uno por hoja (y lado hijo de la FK a la hoja).
CREATE UNIQUE INDEX "sedation_discharges_record_key"
  ON "sedation_discharges"("tenantId", "sedationRecordId");
-- Lado hijo de la FK a las constantes al alta.
CREATE INDEX "sedation_discharges_vitals_idx"
  ON "sedation_discharges"("tenantId", "sedationRecordId", "vitalsId");

ALTER TABLE "sedation_discharges" ADD CONSTRAINT "sedation_discharges_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sedation_discharges" ADD CONSTRAINT "sedation_discharges_tenantId_sedationRecordId_fkey"
  FOREIGN KEY ("tenantId", "sedationRecordId") REFERENCES "sedation_records"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sedation_discharges" ADD CONSTRAINT "sedation_discharges_vitals_fkey"
  FOREIGN KEY ("tenantId", "sedationRecordId", "vitalsId") REFERENCES "sedation_vitals"("tenantId", "sedationRecordId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sedation_discharges" ADD CONSTRAINT "sedation_discharges_operatorId_fkey"
  FOREIGN KEY ("operatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sedation_discharges" ADD CONSTRAINT "sedation_discharges_monitorId_fkey"
  FOREIGN KEY ("monitorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 6. Inalterables, fecha del servidor y RLS forzada (las cinco tablas)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sedation_records',
    'sedation_checklists',
    'sedation_agent_administrations',
    'sedation_vitals',
    'sedation_discharges'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION "dx_forbid_clinical_record_mutation"()',
      t || '_immutable', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION "dx_forbid_clinical_record_mutation"()',
      t || '_no_truncate', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION "dx_clinical_record_server_timestamp"()',
      t || '_server_timestamp', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
    -- Los registros nunca se borran (además del trigger).
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM dentalix_app', t);
  END LOOP;
END
$$;
