-- DX-006: consentimientos informados con plantillas y firma en pantalla.
--
-- Dos tablas nuevas:
--   consent_templates  plantilla por clínica (título + texto con variables),
--                      editable; cada cambio de título/texto sube `version`.
--   patient_consents   consentimiento FIRMADO: append-only e inmutable. Guarda
--                      la foto del texto renderizado, las firmas (PNG base64),
--                      el hash SHA-256 y `signedAt` del servidor.
--
-- Compatible hacia atrás: solo AÑADE (un enum, dos tablas, sus índices, FK,
-- RLS y un trigger). No toca columnas ni datos existentes; el código anterior
-- ignora las tablas nuevas.
--
-- Grants: no hace falta GRANT explícito. Corre con el rol owner "dentalix"
-- (DIRECT_URL) y ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en las
-- tablas nuevas (igual que 20261016120000_appointment_confirmations).

-- CreateEnum
CREATE TYPE "ConsentSignerType" AS ENUM ('PATIENT', 'GUARDIAN');

-- ---------------------------------------------------------------------------
-- consent_templates
-- ---------------------------------------------------------------------------
CREATE TABLE "consent_templates" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consent_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "consent_templates_version_check" CHECK ("version" >= 1),
    CONSTRAINT "consent_templates_title_check" CHECK (length(btrim("title")) > 0),
    CONSTRAINT "consent_templates_body_check" CHECK (length(btrim("body")) > 0)
);

-- Listado de plantillas (todas o solo activas) de la clínica.
CREATE INDEX "consent_templates_tenantId_active_idx" ON "consent_templates"("tenantId", "active");

-- Destino de la FK compuesta de patient_consents (SEC-004). `id` ya es PK, así
-- que no puede fallar por duplicados.
CREATE UNIQUE INDEX "consent_templates_tenant_id_key" ON "consent_templates"("tenantId", "id");

-- Dos plantillas de la misma clínica no comparten título (se distinguen en el
-- selector del modal por el título).
CREATE UNIQUE INDEX "consent_templates_tenant_title_key" ON "consent_templates"("tenantId", "title");

ALTER TABLE "consent_templates" ADD CONSTRAINT "consent_templates_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- patient_consents
-- ---------------------------------------------------------------------------
CREATE TABLE "patient_consents" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "treatmentPlanId" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "signerType" "ConsentSignerType" NOT NULL,
    "signerName" TEXT NOT NULL,
    "signerDocument" TEXT,
    "professionalName" TEXT NOT NULL,
    "patientSignature" TEXT NOT NULL,
    "professionalSignature" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3) NOT NULL,
    "recordedById" UUID NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_consents_pkey" PRIMARY KEY ("id"),
    -- SHA-256 en hex, siempre 64 caracteres en minúscula.
    CONSTRAINT "patient_consents_content_hash_check" CHECK ("contentHash" ~ '^[0-9a-f]{64}$'),
    -- Tope de las firmas: 200 KB decodificados = 273068 caracteres de base64
    -- (4 * ceil(204800 / 3)). La API valida antes (400); esto es la red.
    CONSTRAINT "patient_consents_patient_signature_check"
      CHECK (length("patientSignature") BETWEEN 1 AND 273068),
    CONSTRAINT "patient_consents_professional_signature_check"
      CHECK (length("professionalSignature") BETWEEN 1 AND 273068),
    -- Firma un tutor -> su documento es obligatorio.
    CONSTRAINT "patient_consents_guardian_document_check"
      CHECK ("signerType" <> 'GUARDIAN' OR length(btrim(coalesce("signerDocument", ''))) > 0),
    CONSTRAINT "patient_consents_template_version_check" CHECK ("templateVersion" >= 1)
);

-- Lista de consentimientos del paciente (más reciente primero).
CREATE INDEX "patient_consents_tenantId_patientId_signedAt_idx" ON "patient_consents"("tenantId", "patientId", "signedAt");

-- Lado hijo de las FK compuestas a plantilla y plan.
CREATE INDEX "patient_consents_tenantId_templateId_idx" ON "patient_consents"("tenantId", "templateId");
CREATE INDEX "patient_consents_tenantId_treatmentPlanId_patientId_idx" ON "patient_consents"("tenantId", "treatmentPlanId", "patientId");

-- FK COMPUESTAS (SEC-004, patrón de 20261015130000_tenant_composite_fks): las
-- FK de Postgres se chequean saltando la RLS, así que con una FK simple un
-- consentimiento de la clínica A podía apuntar a un paciente, una plantilla o
-- un plan de la clínica B. RESTRICT: un consentimiento firmado es documento
-- médico-legal y nunca debe quedarse sin su paciente.
ALTER TABLE "patient_consents" ADD CONSTRAINT "patient_consents_tenantId_patientId_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "patient_consents" ADD CONSTRAINT "patient_consents_tenantId_templateId_fkey"
  FOREIGN KEY ("tenantId", "templateId") REFERENCES "consent_templates"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- El plan es opcional (MATCH SIMPLE: con treatmentPlanId NULL no se chequea).
-- Si viene, tiene que ser del MISMO tenant y del MISMO paciente (mismo
-- criterio que payments -> treatment_plans).
ALTER TABLE "patient_consents" ADD CONSTRAINT "patient_consents_tenantId_treatmentPlanId_patientId_fkey"
  FOREIGN KEY ("tenantId", "treatmentPlanId", "patientId") REFERENCES "treatment_plans"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Inmutabilidad (capa DB). La app no tiene endpoint ni método de repositorio
-- para editar o borrar un consentimiento; este trigger lo hace imposible
-- aunque una ruta futura se lo salte:
--   - UPDATE: siempre rechazado.
--   - DELETE: rechazado dentro de un contexto de tenant (`app.current_tenant`
--     fijado, que es como corre TODA la app vía runWithTenant). Fuera de él
--     (rol owner, limpieza administrativa de una base de test) se permite.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "patient_consents_immutable"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'patient_consents es inmutable: un consentimiento firmado no se modifica'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF coalesce(current_setting('app.current_tenant', true), '') <> '' THEN
    RAISE EXCEPTION 'patient_consents es inmutable: un consentimiento firmado no se borra'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "patient_consents_immutable"
  BEFORE UPDATE OR DELETE ON "patient_consents"
  FOR EACH ROW EXECUTE FUNCTION "patient_consents_immutable"();

-- ---------------------------------------------------------------------------
-- RLS por tenant (mismo patrón que appointment_confirmations).
-- ---------------------------------------------------------------------------
ALTER TABLE "consent_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "consent_templates" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "consent_templates"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "patient_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_consents" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "patient_consents"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
