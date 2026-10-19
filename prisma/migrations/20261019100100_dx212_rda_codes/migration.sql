-- DX-212: códigos para el Resumen Digital de Atención (Res. 1888/2025) y el
-- RIPS: CIE-10 de los diagnósticos, CUPS de los procedimientos y código de
-- habilitación REPS de la sede.
--
-- Cambios (todos ADITIVOS, compatibles hacia atrás: el código anterior no lee
-- ni escribe nada de esto y las evoluciones antiguas quedan sin diagnóstico):
--   icd10_codes               tabla de REFERENCIA global (sin tenant ni RLS,
--       como currencies/countries/cities). La siembra `prisma db seed`
--       (upsert por código). `search_text` generada con dx_search_normalize
--       (sin tildes ni mayúsculas, código con y sin punto) + índice trigram:
--       «caries», «K02» o «k021» encuentran K02.1.
--   dental_catalog_items."cupsCode"          NULL o 6 alfanuméricos (CHECK).
--   locations."repsHabilitationCode"         NULL o 12 dígitos (CHECK).
--       Columnas nuevas sin DEFAULT: solo metadatos, sin reescribir la tabla.
--       Los CHECK recorren la tabla, pero todas las filas valen NULL; los
--       CHECK ven las filas aunque haya RLS FORCE (README, DX-134).
--   "ClinicalDiagnosisKind"   PRINCIPAL | RELACIONADO.
--   clinical_entry_diagnoses  diagnósticos de una evolución: posición 0 =
--       PRINCIPAL, 1..3 = relacionados (CHECK + único por evolución y
--       posición). FK compuesta a la evolución (misma clínica y paciente) y a
--       icd10_codes (RESTRICT). INALTERABLE como la evolución (DX-038) y SOLO
--       se inserta en la misma transacción que su evolución (trigger). RLS
--       FORZADA por tenant.
--
-- FK bajo FORCE (DX-134): las FK nuevas son de una tabla hija creada en esta
-- migración (vacía), así que no necesitan NO FORCE. Grants: ALTER DEFAULT
-- PRIVILEGES ya cubre a dentalix_app en las tablas nuevas.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. CIE-10 (referencia global).
-- ---------------------------------------------------------------------------
CREATE TABLE "icd10_codes" (
    "code" TEXT NOT NULL,
    "label_es" TEXT NOT NULL,
    "search_text" TEXT GENERATED ALWAYS AS (
      public.dx_search_normalize(
        "code" || ' ' || replace("code", '.', '') || ' ' || "label_es"
      )
    ) STORED,

    CONSTRAINT "icd10_codes_pkey" PRIMARY KEY ("code"),
    CONSTRAINT "icd10_codes_code_format"
      CHECK ("code" ~ '^[A-Z][0-9]{2}(\.[0-9A-Z]{1,2})?$'),
    CONSTRAINT "icd10_codes_label_len"
      CHECK (char_length(btrim("label_es")) BETWEEN 1 AND 300)
);

-- Búsqueda por código o texto (ILIKE '%…%' sobre search_text).
CREATE INDEX "icd10_codes_search_text_trgm_idx"
  ON "icd10_codes" USING GIN ("search_text" gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 2. CUPS en el catálogo y REPS en la sede.
-- ---------------------------------------------------------------------------
ALTER TABLE "dental_catalog_items" ADD COLUMN "cupsCode" TEXT;
ALTER TABLE "dental_catalog_items" ADD CONSTRAINT "dental_catalog_items_cups_code_format"
  CHECK ("cupsCode" IS NULL OR "cupsCode" ~ '^[A-Z0-9]{6}$');

ALTER TABLE "locations" ADD COLUMN "repsHabilitationCode" TEXT;
ALTER TABLE "locations" ADD CONSTRAINT "locations_reps_habilitation_code_format"
  CHECK ("repsHabilitationCode" IS NULL OR "repsHabilitationCode" ~ '^[0-9]{12}$');

-- ---------------------------------------------------------------------------
-- 3. Diagnósticos de la evolución.
-- ---------------------------------------------------------------------------
CREATE TYPE "ClinicalDiagnosisKind" AS ENUM ('PRINCIPAL', 'RELACIONADO');

CREATE TABLE "clinical_entry_diagnoses" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "clinicalEntryId" UUID NOT NULL,
    "icd10Code" TEXT NOT NULL,
    "kind" "ClinicalDiagnosisKind" NOT NULL,
    "toothFdi" TEXT,
    "position" SMALLINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinical_entry_diagnoses_pkey" PRIMARY KEY ("id"),
    -- Mismo patrón FDI que el odontograma (permanentes y temporales).
    CONSTRAINT "clinical_entry_diagnoses_tooth_fdi"
      CHECK ("toothFdi" IS NULL OR "toothFdi" ~ '^([1-4][1-8]|[5-8][1-5])$'),
    -- 0 = el principal; 1..3 = relacionados. Con el único de abajo: como mucho
    -- un principal y tres relacionados por evolución.
    CONSTRAINT "clinical_entry_diagnoses_position_kind"
      CHECK (("kind" = 'PRINCIPAL' AND "position" = 0)
          OR ("kind" = 'RELACIONADO' AND "position" BETWEEN 1 AND 3))
);

CREATE UNIQUE INDEX "clinical_entry_diagnoses_entry_position_key"
  ON "clinical_entry_diagnoses"("tenantId", "patientId", "clinicalEntryId", "position");
-- Lado hijo de la FK a icd10_codes (RESTRICT al borrar un código).
CREATE INDEX "clinical_entry_diagnoses_icd10Code_idx"
  ON "clinical_entry_diagnoses"("icd10Code");

-- DB-028: FK de tenantId explícita. SEC-004: la evolución es de la MISMA
-- clínica y del MISMO paciente. RESTRICT: es historia clínica.
ALTER TABLE "clinical_entry_diagnoses" ADD CONSTRAINT "clinical_entry_diagnoses_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "clinical_entry_diagnoses" ADD CONSTRAINT "clinical_entry_diagnoses_tenantId_patientId_clinicalEntryI_fkey"
  FOREIGN KEY ("tenantId", "patientId", "clinicalEntryId") REFERENCES "clinical_entries"("tenantId", "patientId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "clinical_entry_diagnoses" ADD CONSTRAINT "clinical_entry_diagnoses_icd10Code_fkey"
  FOREIGN KEY ("icd10Code") REFERENCES "icd10_codes"("code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Inalterable: la misma función que las evoluciones y las adendas (DX-038,
-- search_path fijo con pg_temp al final — SEC-032): ni UPDATE ni DELETE para
-- el rol de la app; DELETE/TRUNCATE solo un superusuario (purga).
CREATE TRIGGER "clinical_entry_diagnoses_immutable"
  BEFORE UPDATE OR DELETE ON "clinical_entry_diagnoses"
  FOR EACH ROW EXECUTE FUNCTION "dx_forbid_clinical_record_mutation"();
CREATE TRIGGER "clinical_entry_diagnoses_no_truncate"
  BEFORE TRUNCATE ON "clinical_entry_diagnoses"
  FOR EACH STATEMENT EXECUTE FUNCTION "dx_forbid_clinical_record_mutation"();
CREATE TRIGGER "clinical_entry_diagnoses_server_timestamp"
  BEFORE INSERT ON "clinical_entry_diagnoses"
  FOR EACH ROW EXECUTE FUNCTION "dx_clinical_record_server_timestamp"();

-- Solo con su evolución: el diagnóstico se inserta en la MISMA transacción que
-- la evolución (su createdAt lo pone el servidor en UTC, DX-226:
-- timezone('UTC', now()), el inicio de la transacción, sea cual sea la zona
-- de la sesión). Añadir un diagnóstico a una evolución ya guardada
-- la cambiaría a posteriori. SECURITY INVOKER: lee la evolución bajo la RLS
-- del rol que inserta. search_path fijo y tabla calificada (SEC-032).
CREATE FUNCTION "dx_clinical_entry_diagnosis_with_entry"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public."clinical_entries" e
     WHERE e."tenantId" = NEW."tenantId"
       AND e."patientId" = NEW."patientId"
       AND e."id" = NEW."clinicalEntryId"
       AND e."createdAt" = pg_catalog.timezone('UTC', pg_catalog.now())::timestamp(3)
  ) THEN
    RAISE EXCEPTION 'clinical_entry_diagnoses es inalterable: un diagnóstico solo se registra junto con su evolución; para corregir se añade una adenda y una evolución nueva (DX-212)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "clinical_entry_diagnoses_with_entry"
  BEFORE INSERT ON "clinical_entry_diagnoses"
  FOR EACH ROW EXECUTE FUNCTION "dx_clinical_entry_diagnosis_with_entry"();

-- RLS forzada por tenant (dato de salud sensible, Ley 1581).
ALTER TABLE "clinical_entry_diagnoses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clinical_entry_diagnoses" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "clinical_entry_diagnoses"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
