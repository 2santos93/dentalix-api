-- DX-170: plantillas de evolución con preguntas, y evolución ligada a la cita.
--
-- Cambios:
--   clinical_note_templates         plantillas de la clínica: nombre, carpeta
--                                   (categoría), cuerpo con marcadores
--                                   {{Etiqueta}} y activo. Nunca se borran.
--   clinical_note_template_prompts  preguntas de cada plantilla: tipo ONE |
--                                   MULTI | TEXT, etiqueta (<= 50), opciones,
--                                   valor por defecto y orden.
--   appointments                    UNIQUE ("tenantId", "patientId", "id"):
--                                   destino de la FK compuesta de abajo. No
--                                   puede fallar: "id" ya es la PK.
--   clinical_entries.appointmentId  cita en la que se documentó la evolución,
--                                   con FK COMPUESTA (tenantId, patientId,
--                                   appointmentId): la cita es de la MISMA
--                                   clínica y del MISMO paciente.
--   clinical_entries.templateId     plantilla con la que se redactó, con FK
--                                   compuesta (tenantId, templateId).
--
-- La evolución sigue INALTERABLE (DX-038): el texto compuesto se guarda en
-- "notes" y las FK son ON DELETE/UPDATE RESTRICT, así que nada en las tablas
-- referenciadas puede reescribirla en cascada (y el trigger lo impediría).
--
-- Compatible hacia atrás: solo AÑADE (un enum, dos tablas, dos columnas NULL sin
-- default, índices, FK, CHECK y RLS). Las columnas nuevas nacen a NULL: ADD
-- COLUMN sin default no reescribe la tabla ni dispara los triggers de fila.
--
-- FK sobre tablas con RLS FORCE (DX-134, README «Despliegue: roles de la BD»):
-- las FK de las tablas nuevas van DENTRO de su CREATE TABLE (nacen vacías); las
-- de clinical_entries se añaden con NO FORCE en clinical_entries y appointments
-- y se vuelve a FORCE al final de esta misma migración, para que el owner sin
-- BYPASSRLS valide viendo todas las filas.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "ClinicalNotePromptType" AS ENUM ('ONE', 'MULTI', 'TEXT');

-- ---------------------------------------------------------------------------
-- clinical_note_templates
-- ---------------------------------------------------------------------------
CREATE TABLE "clinical_note_templates" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clinical_note_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "clinical_note_templates_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Mismos topes que la API (400 en español antes); esto es la red.
    CONSTRAINT "clinical_note_templates_name_check"
      CHECK (char_length(btrim("name")) BETWEEN 1 AND 80),
    CONSTRAINT "clinical_note_templates_category_check"
      CHECK ("category" IS NULL OR char_length(btrim("category")) BETWEEN 1 AND 60),
    CONSTRAINT "clinical_note_templates_body_check"
      CHECK (char_length(btrim("body")) BETWEEN 1 AND 5000)
);

-- Destino de las FK compuestas de las preguntas y de clinical_entries (SEC-004).
CREATE UNIQUE INDEX "clinical_note_templates_tenant_id_key" ON "clinical_note_templates"("tenantId", "id");
-- Dos plantillas de la misma clínica no comparten nombre (y «Cargar ejemplos»
-- no duplica las que ya están).
CREATE UNIQUE INDEX "clinical_note_templates_tenant_name_key" ON "clinical_note_templates"("tenantId", "name");
-- Listado por carpeta y nombre (selector y Ajustes).
CREATE INDEX "clinical_note_templates_tenant_category_name_idx" ON "clinical_note_templates"("tenantId", "category", "name");

-- ---------------------------------------------------------------------------
-- clinical_note_template_prompts
-- ---------------------------------------------------------------------------
CREATE TABLE "clinical_note_template_prompts" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "type" "ClinicalNotePromptType" NOT NULL,
    "options" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "defaultValue" TEXT,
    "position" INTEGER NOT NULL,

    CONSTRAINT "clinical_note_template_prompts_pkey" PRIMARY KEY ("id"),
    -- FK COMPUESTA: la pregunta es de una plantilla de la MISMA clínica.
    CONSTRAINT "clinical_note_template_prompts_tenantId_templateId_fkey"
      FOREIGN KEY ("tenantId", "templateId") REFERENCES "clinical_note_templates"("tenantId", "id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "clinical_note_template_prompts_label_check"
      CHECK (char_length(btrim("label")) BETWEEN 1 AND 50),
    CONSTRAINT "clinical_note_template_prompts_position_check"
      CHECK ("position" BETWEEN 0 AND 49),
    -- ONE/MULTI con 1 a 20 opciones; TEXT sin opciones.
    CONSTRAINT "clinical_note_template_prompts_options_check" CHECK (
      ("type" = 'TEXT' AND cardinality("options") = 0)
      OR ("type" IN ('ONE', 'MULTI') AND cardinality("options") BETWEEN 1 AND 20)
    )
);

-- Preguntas de una plantilla en su orden (y lado hijo de la FK compuesta).
CREATE UNIQUE INDEX "clinical_note_template_prompts_position_key"
  ON "clinical_note_template_prompts"("tenantId", "templateId", "position");

ALTER TABLE "clinical_note_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clinical_note_template_prompts" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "clinical_note_templates"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation ON "clinical_note_template_prompts"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- clinical_entries.appointmentId / templateId
-- ---------------------------------------------------------------------------
ALTER TABLE "clinical_entries" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments" NO FORCE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX "appointments_tenant_patient_id_key" ON "appointments"("tenantId", "patientId", "id");

ALTER TABLE "clinical_entries"
  ADD COLUMN "appointmentId" UUID,
  ADD COLUMN "templateId" UUID;

-- Lados hijos de las FK, PARCIALES: casi todas las evoluciones antiguas no
-- tienen cita ni plantilla. Sirven también «evoluciones de esta cita».
CREATE INDEX "clinical_entries_tenant_patient_appointment_idx"
  ON "clinical_entries"("tenantId", "patientId", "appointmentId")
  WHERE "appointmentId" IS NOT NULL;
CREATE INDEX "clinical_entries_tenant_template_idx"
  ON "clinical_entries"("tenantId", "templateId")
  WHERE "templateId" IS NOT NULL;

-- MATCH SIMPLE (el default): con la columna NULL la FK no se evalúa.
ALTER TABLE "clinical_entries" ADD CONSTRAINT "clinical_entries_tenantId_patientId_appointmentId_fkey"
  FOREIGN KEY ("tenantId", "patientId", "appointmentId") REFERENCES "appointments"("tenantId", "patientId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "clinical_entries" ADD CONSTRAINT "clinical_entries_tenantId_templateId_fkey"
  FOREIGN KEY ("tenantId", "templateId") REFERENCES "clinical_note_templates"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "clinical_entries" FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "clinical_note_templates" FORCE ROW LEVEL SECURITY;
ALTER TABLE "clinical_note_template_prompts" FORCE ROW LEVEL SECURITY;
