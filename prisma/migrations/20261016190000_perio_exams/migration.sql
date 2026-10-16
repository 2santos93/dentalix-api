-- DX-007: periodontograma con histórico.
--
-- Tres tablas nuevas:
--   perio_exams           un examen periodontal por paciente y fecha (DRAFT o
--                         FINAL). FINAL es inmutable: una corrección es un
--                         examen nuevo.
--   perio_site_measures   medidas por (examen, diente FDI, sitio): sondaje,
--                         recesión, furca y flags (BOP=1|SUP=2|PLAQ=4|CALC=8).
--   perio_tooth_measures  medidas por (examen, diente): movilidad y omitido.
--
-- Convención de recesión: `recessionMm` POSITIVO = margen gingival apical a la
-- UAC (recesión); NEGATIVO = margen coronal a la UAC. NIC/CAL = sondaje +
-- recesión, CALCULADO en la app (no se persiste).
--
-- Compatible hacia atrás: solo AÑADE (dos enums, tres tablas, índices, FK,
-- CHECK, RLS y triggers). No toca columnas ni datos existentes.
--
-- Nada se borra en duro (convención de Dentalix, no-hard-delete.ts): un
-- borrador se retira con `deletedAt`; limpiar una celda deja la fila de la
-- medida con todo a NULL/0 (la app no la muestra ni la cuenta).
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas
-- (igual que 20261016180000_patient_consents).

-- CreateEnum
CREATE TYPE "PerioExamStatus" AS ENUM ('DRAFT', 'FINAL');

-- CreateEnum
CREATE TYPE "PerioSite" AS ENUM ('MB', 'B', 'DB', 'ML', 'L', 'DL');

-- ---------------------------------------------------------------------------
-- perio_exams
-- ---------------------------------------------------------------------------
CREATE TABLE "perio_exams" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "examDate" DATE NOT NULL,
    "notes" TEXT,
    "status" "PerioExamStatus" NOT NULL DEFAULT 'DRAFT',
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "perio_exams_pkey" PRIMARY KEY ("id"),
    -- FINAL <=> tiene fecha de cierre.
    CONSTRAINT "perio_exams_finalized_check"
      CHECK (("status" = 'FINAL') = ("finalizedAt" IS NOT NULL))
);

-- Histórico del paciente, más reciente primero (GET /patients/:id/perio-exams).
CREATE INDEX "perio_exams_tenantId_patientId_examDate_idx" ON "perio_exams"("tenantId", "patientId", "examDate" DESC);
-- Lado hijo de la FK a users.
CREATE INDEX "perio_exams_providerId_idx" ON "perio_exams"("providerId");
-- Destino de las FK compuestas de las medidas (SEC-004).
CREATE UNIQUE INDEX "perio_exams_tenant_id_key" ON "perio_exams"("tenantId", "id");

-- ---------------------------------------------------------------------------
-- perio_site_measures
-- ---------------------------------------------------------------------------
CREATE TABLE "perio_site_measures" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "examId" UUID NOT NULL,
    "toothFdi" SMALLINT NOT NULL,
    "site" "PerioSite" NOT NULL,
    "probingMm" SMALLINT,
    "recessionMm" SMALLINT,
    "furcation" SMALLINT,
    "flags" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "perio_site_measures_pkey" PRIMARY KEY ("id"),
    -- Dentición permanente: cuadrantes 1-4, dientes 1-8. La API valida antes
    -- (400 en español); esto es la red.
    CONSTRAINT "perio_site_measures_tooth_check"
      CHECK ("toothFdi" / 10 BETWEEN 1 AND 4 AND "toothFdi" % 10 BETWEEN 1 AND 8),
    CONSTRAINT "perio_site_measures_probing_check"
      CHECK ("probingMm" IS NULL OR "probingMm" BETWEEN 0 AND 19),
    CONSTRAINT "perio_site_measures_recession_check"
      CHECK ("recessionMm" IS NULL OR "recessionMm" BETWEEN -5 AND 19),
    CONSTRAINT "perio_site_measures_furcation_check"
      CHECK ("furcation" IS NULL OR "furcation" BETWEEN 0 AND 3),
    CONSTRAINT "perio_site_measures_flags_check"
      CHECK ("flags" BETWEEN 0 AND 15)
);

-- Único (examen, diente, sitio); también sirve de índice del lado hijo de la
-- FK compuesta (empieza por tenantId, examId).
CREATE UNIQUE INDEX "perio_site_measures_exam_tooth_site_key" ON "perio_site_measures"("tenantId", "examId", "toothFdi", "site");

-- ---------------------------------------------------------------------------
-- perio_tooth_measures
-- ---------------------------------------------------------------------------
CREATE TABLE "perio_tooth_measures" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "examId" UUID NOT NULL,
    "toothFdi" SMALLINT NOT NULL,
    "mobility" SMALLINT,
    "skipped" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "perio_tooth_measures_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "perio_tooth_measures_tooth_check"
      CHECK ("toothFdi" / 10 BETWEEN 1 AND 4 AND "toothFdi" % 10 BETWEEN 1 AND 8),
    CONSTRAINT "perio_tooth_measures_mobility_check"
      CHECK ("mobility" IS NULL OR "mobility" BETWEEN 0 AND 3)
);

CREATE UNIQUE INDEX "perio_tooth_measures_exam_tooth_key" ON "perio_tooth_measures"("tenantId", "examId", "toothFdi");

-- ---------------------------------------------------------------------------
-- FK. COMPUESTAS por tenant (SEC-004, patrón de 20261015130000): las FK de
-- Postgres se chequean saltando la RLS. RESTRICT al paciente: un examen es
-- dato clínico y no se queda sin paciente. CASCADE de examen a medidas: la app
-- no borra en duro; solo aplica a la limpieza administrativa (owner).
-- ---------------------------------------------------------------------------
ALTER TABLE "perio_exams" ADD CONSTRAINT "perio_exams_tenantId_patientId_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "perio_exams" ADD CONSTRAINT "perio_exams_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "perio_site_measures" ADD CONSTRAINT "perio_site_measures_tenantId_examId_fkey"
  FOREIGN KEY ("tenantId", "examId") REFERENCES "perio_exams"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "perio_tooth_measures" ADD CONSTRAINT "perio_tooth_measures_tenantId_examId_fkey"
  FOREIGN KEY ("tenantId", "examId") REFERENCES "perio_exams"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Inmutabilidad de un examen FINAL (capa DB). La app ya responde 409; esto lo
-- hace imposible aunque una ruta futura se lo salte. Igual que
-- patient_consents_immutable: solo se aplica DENTRO de un contexto de tenant
-- (`app.current_tenant`, que es como corre TODA la app). Fuera de él (rol
-- owner, limpieza de una base de test) se permite.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "perio_exams_final_immutable"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'FINAL'
     AND coalesce(current_setting('app.current_tenant', true), '') <> '' THEN
    RAISE EXCEPTION 'perio_exams: un examen periodontal finalizado no se modifica ni se borra'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "perio_exams_final_immutable"
  BEFORE UPDATE OR DELETE ON "perio_exams"
  FOR EACH ROW EXECUTE FUNCTION "perio_exams_final_immutable"();

CREATE FUNCTION "perio_measures_final_immutable"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  target_exam UUID;
BEGIN
  IF coalesce(current_setting('app.current_tenant', true), '') = '' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    target_exam := OLD."examId";
  ELSE
    target_exam := NEW."examId";
  END IF;
  IF EXISTS (
    SELECT 1 FROM "perio_exams" e WHERE e."id" = target_exam AND e."status" = 'FINAL'
  ) THEN
    RAISE EXCEPTION 'perio: las medidas de un examen finalizado no se modifican'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "perio_site_measures_final_immutable"
  BEFORE INSERT OR UPDATE OR DELETE ON "perio_site_measures"
  FOR EACH ROW EXECUTE FUNCTION "perio_measures_final_immutable"();

CREATE TRIGGER "perio_tooth_measures_final_immutable"
  BEFORE INSERT OR UPDATE OR DELETE ON "perio_tooth_measures"
  FOR EACH ROW EXECUTE FUNCTION "perio_measures_final_immutable"();

-- ---------------------------------------------------------------------------
-- RLS por tenant (mismo patrón que patient_consents).
-- ---------------------------------------------------------------------------
ALTER TABLE "perio_exams" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "perio_exams" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "perio_exams"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "perio_site_measures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "perio_site_measures" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "perio_site_measures"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "perio_tooth_measures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "perio_tooth_measures" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "perio_tooth_measures"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
