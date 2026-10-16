-- DX-013: recetas imprimibles con campos legales por país (CO/ES), inmutables,
-- plantillas y alerta de alergias.
--
-- Cambios:
--   locations.country              país de la sede (CO por defecto: todas las
--                                  sedes existentes son colombianas).
--   clinic_memberships.professionalLicense
--                                  registro profesional (CO) / nº de colegiado
--                                  (ES) del miembro en esta clínica.
--   prescription_templates         plantillas de receta de la clínica.
--   prescriptions                  receta EMITIDA: foto de los datos legales y
--                                  hash SHA-256; solo se anula, no se edita.
--   prescription_items             medicamentos de la receta (inmutables).
--
-- Compatible hacia atrás: solo AÑADE (dos enums, dos columnas con default o
-- NULL, tres tablas, índices, FK, CHECK, RLS y triggers). El código anterior
-- ignora lo nuevo.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas
-- (igual que 20261016180000_patient_consents).

-- CreateEnum
CREATE TYPE "ClinicCountry" AS ENUM ('CO', 'ES');

-- CreateEnum
CREATE TYPE "PrescriptionStatus" AS ENUM ('ISSUED', 'VOIDED');

-- AlterTable: país de la sede. Con DEFAULT constante, Postgres no reescribe la
-- tabla (cambio solo de catálogo).
ALTER TABLE "locations" ADD COLUMN "country" "ClinicCountry" NOT NULL DEFAULT 'CO';

-- AlterTable: registro profesional / nº de colegiado.
ALTER TABLE "clinic_memberships" ADD COLUMN "professionalLicense" TEXT;
ALTER TABLE "clinic_memberships" ADD CONSTRAINT "clinic_memberships_professional_license_check"
  CHECK ("professionalLicense" IS NULL OR length(btrim("professionalLicense")) BETWEEN 1 AND 60);

-- ---------------------------------------------------------------------------
-- prescription_templates
-- ---------------------------------------------------------------------------
CREATE TABLE "prescription_templates" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "items" JSONB NOT NULL,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "prescription_templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "prescription_templates_name_check" CHECK (length(btrim("name")) > 0),
    -- Al menos un medicamento (la API valida antes con 400 en español).
    CONSTRAINT "prescription_templates_items_check"
      CHECK (jsonb_typeof("items") = 'array' AND jsonb_array_length("items") BETWEEN 1 AND 10)
);

-- Dos plantillas VIVAS de la misma clínica no comparten nombre; una retirada
-- (deletedAt) no bloquea reutilizarlo.
CREATE UNIQUE INDEX "prescription_templates_tenant_name_key" ON "prescription_templates"("tenantId", "name") WHERE "deletedAt" IS NULL;

-- Listado de plantillas vivas de la clínica.
CREATE INDEX "prescription_templates_tenantId_deletedAt_idx" ON "prescription_templates"("tenantId", "deletedAt");

ALTER TABLE "prescription_templates" ADD CONSTRAINT "prescription_templates_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- prescriptions
-- ---------------------------------------------------------------------------
CREATE TABLE "prescriptions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "professionalId" UUID NOT NULL,
    "country" "ClinicCountry" NOT NULL,
    "status" "PrescriptionStatus" NOT NULL DEFAULT 'ISSUED',
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "dispensationDate" DATE NOT NULL,
    "validUntil" DATE NOT NULL,
    "patientName" TEXT NOT NULL,
    "patientDocument" TEXT,
    "patientBirthYear" INTEGER,
    "clinicalRecordNumber" TEXT,
    "professionalName" TEXT NOT NULL,
    "professionalLicense" TEXT NOT NULL,
    "professionalEmail" TEXT,
    "clinicName" TEXT NOT NULL,
    "locationName" TEXT NOT NULL,
    "locationAddress" TEXT,
    "notes" TEXT,
    "allergyOverride" BOOLEAN NOT NULL DEFAULT false,
    "allergyMatches" JSONB,
    "contentHash" TEXT NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidedById" UUID,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prescriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "prescriptions_content_hash_check" CHECK ("contentHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "prescriptions_professional_license_check" CHECK (length(btrim("professionalLicense")) > 0),
    CONSTRAINT "prescriptions_valid_until_check" CHECK ("validUntil" >= "dispensationDate"),
    -- Campos legales por país (la API responde 400 antes; esto es la red).
    CONSTRAINT "prescriptions_country_fields_check" CHECK (
      ("country" = 'CO' AND "clinicalRecordNumber" IS NOT NULL)
      OR ("country" = 'ES' AND "patientDocument" IS NOT NULL AND "patientBirthYear" IS NOT NULL)
    ),
    -- ANULADA <=> fecha, autor y motivo de la anulación.
    CONSTRAINT "prescriptions_void_check" CHECK (
      ("status" = 'VOIDED') = (
        "voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL
        AND length(btrim(coalesce("voidReason", ''))) > 0
      )
    ),
    -- Confirmar una alergia exige saber cuál.
    CONSTRAINT "prescriptions_allergy_check" CHECK (NOT "allergyOverride" OR "allergyMatches" IS NOT NULL)
);

-- Lista de recetas del paciente, más reciente primero.
CREATE INDEX "prescriptions_tenantId_patientId_issuedAt_idx" ON "prescriptions"("tenantId", "patientId", "issuedAt" DESC);
-- Lado hijo de la FK compuesta a la sede.
CREATE INDEX "prescriptions_tenantId_locationId_idx" ON "prescriptions"("tenantId", "locationId");
-- Lado hijo de las FK a users.
CREATE INDEX "prescriptions_professionalId_idx" ON "prescriptions"("professionalId");
CREATE INDEX "prescriptions_voidedById_idx" ON "prescriptions"("voidedById");
-- Destino de la FK compuesta de los medicamentos (SEC-004).
CREATE UNIQUE INDEX "prescriptions_tenant_id_key" ON "prescriptions"("tenantId", "id");

-- ---------------------------------------------------------------------------
-- prescription_items
-- ---------------------------------------------------------------------------
CREATE TABLE "prescription_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "prescriptionId" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "activeIngredient" TEXT NOT NULL,
    "brandName" TEXT,
    "concentration" TEXT NOT NULL,
    "pharmaceuticalForm" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "dose" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "totalQuantity" INTEGER NOT NULL,
    "quantityUnit" TEXT NOT NULL,
    "quantityInWords" TEXT NOT NULL,
    "packages" INTEGER,
    "instructions" TEXT,

    CONSTRAINT "prescription_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "prescription_items_position_check" CHECK ("position" BETWEEN 1 AND 10),
    CONSTRAINT "prescription_items_active_ingredient_check" CHECK (length(btrim("activeIngredient")) > 0),
    CONSTRAINT "prescription_items_duration_check" CHECK ("durationDays" BETWEEN 1 AND 365),
    CONSTRAINT "prescription_items_quantity_check" CHECK ("totalQuantity" BETWEEN 1 AND 9999),
    CONSTRAINT "prescription_items_packages_check" CHECK ("packages" IS NULL OR "packages" BETWEEN 1 AND 99)
);

-- Único (receta, posición); también es el índice del lado hijo de la FK
-- compuesta (empieza por tenantId, prescriptionId).
CREATE UNIQUE INDEX "prescription_items_rx_position_key" ON "prescription_items"("tenantId", "prescriptionId", "position");

-- ---------------------------------------------------------------------------
-- FK COMPUESTAS por tenant (SEC-004, patrón de 20261015130000): las FK de
-- Postgres se chequean saltando la RLS. RESTRICT a paciente y sede: una receta
-- es documento médico-legal. CASCADE de receta a medicamentos: la app nunca
-- borra; solo aplica a la limpieza administrativa (owner).
-- ---------------------------------------------------------------------------
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_tenantId_patientId_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_tenantId_locationId_fkey"
  FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_professionalId_fkey"
  FOREIGN KEY ("professionalId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_voidedById_fkey"
  FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_tenantId_prescriptionId_fkey"
  FOREIGN KEY ("tenantId", "prescriptionId") REFERENCES "prescriptions"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Inmutabilidad (capa DB). La app solo inserta y anula; esto lo hace imposible
-- aunque una ruta futura se lo salte.
--
-- prescriptions:
--   - UPDATE: solo la ANULACIÓN, es decir ISSUED -> VOIDED cambiando ÚNICAMENTE
--     status, voidedAt, voidedById y voidReason. Una anulada no cambia más.
--     Vale también para el rol owner (como patient_consents).
--   - DELETE: rechazado dentro de un contexto de tenant (la app); fuera de él
--     (owner, limpieza de una base de test) se permite.
-- prescription_items:
--   - UPDATE: siempre rechazado.
--   - INSERT: solo en la MISMA transacción que creó la receta (xmin de la fila
--     padre = transacción actual) y con la receta aún ISSUED: no se añaden
--     medicamentos a una receta ya emitida. La anulación también renueva el
--     xmin, de ahí exigir ISSUED (si no, anular y añadir en la misma
--     transacción colaría un medicamento en una receta anulada).
--   - DELETE: como la receta.
-- ---------------------------------------------------------------------------
CREATE FUNCTION "prescriptions_immutable"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  void_columns CONSTANT text[] := ARRAY['status', 'voidedAt', 'voidedById', 'voidReason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('app.current_tenant', true), '') <> '' THEN
      RAISE EXCEPTION 'prescriptions es inmutable: una receta emitida no se borra'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" <> 'ISSUED' OR NEW."status" <> 'VOIDED'
     OR (to_jsonb(NEW) - void_columns) IS DISTINCT FROM (to_jsonb(OLD) - void_columns) THEN
    RAISE EXCEPTION 'prescriptions es inmutable: una receta emitida solo se puede anular'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "prescriptions_immutable"
  BEFORE UPDATE OR DELETE ON "prescriptions"
  FOR EACH ROW EXECUTE FUNCTION "prescriptions_immutable"();

CREATE FUNCTION "prescription_items_immutable"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'prescription_items es inmutable: los medicamentos de una receta emitida no se modifican'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('app.current_tenant', true), '') <> '' THEN
      RAISE EXCEPTION 'prescription_items es inmutable: los medicamentos de una receta emitida no se borran'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "prescriptions" p
     WHERE p."id" = NEW."prescriptionId"
       AND p."tenantId" = NEW."tenantId"
       AND p."status" = 'ISSUED'
       AND p."xmin" = pg_current_xact_id()::xid
  ) THEN
    RAISE EXCEPTION 'prescription_items es inmutable: no se añaden medicamentos a una receta ya emitida'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "prescription_items_immutable"
  BEFORE INSERT OR UPDATE OR DELETE ON "prescription_items"
  FOR EACH ROW EXECUTE FUNCTION "prescription_items_immutable"();

-- ---------------------------------------------------------------------------
-- RLS por tenant (mismo patrón que patient_consents).
-- ---------------------------------------------------------------------------
ALTER TABLE "prescription_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "prescription_templates" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "prescription_templates"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "prescriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "prescriptions" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "prescriptions"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "prescription_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "prescription_items" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "prescription_items"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
