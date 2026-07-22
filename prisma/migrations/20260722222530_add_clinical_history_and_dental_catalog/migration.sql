-- CreateEnum
CREATE TYPE "CatalogKind" AS ENUM ('DIAGNOSIS', 'PROCEDURE');

-- CreateTable
CREATE TABLE "medical_history_versions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "allergies" TEXT,
    "chronicConditions" TEXT,
    "currentMedications" TEXT,
    "habits" TEXT,
    "medicalAlerts" TEXT,
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "medical_history_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical_entries" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "notes" TEXT NOT NULL,
    "performedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "clinical_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dental_catalog_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "category" TEXT,
    "kind" "CatalogKind" NOT NULL,
    "labelEs" TEXT NOT NULL,
    "labelEn" TEXT,
    "labelPt" TEXT,
    "color" TEXT NOT NULL,
    "defaultPrice" DECIMAL(12,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "dental_catalog_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "medical_history_versions_tenantId_patientId_idx" ON "medical_history_versions"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "clinical_entries_tenantId_patientId_entryDate_idx" ON "clinical_entries"("tenantId", "patientId", "entryDate");

-- CreateIndex
CREATE INDEX "dental_catalog_items_tenantId_idx" ON "dental_catalog_items"("tenantId");

-- AddForeignKey
ALTER TABLE "medical_history_versions" ADD CONSTRAINT "medical_history_versions_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical_entries" ADD CONSTRAINT "clinical_entries_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Únicos parciales (soft-delete safe): mismo patrón que
-- 20260722184531_partial_unique_indexes / 20260722185208_add_patients.
-- schema.prisma SÍ declara `@@unique([...], map: "...")` en
-- MedicalHistoryVersion y DentalCatalogItem para que el nombre+columnas
-- coincidan con estos índices y `prisma migrate status`/`migrate deploy` no
-- vean drift. Prisma sigue sin poder representar el WHERE, así que un
-- `prisma migrate dev` en frío puede proponer recrear el índice sin el
-- filtro parcial; no aceptar ese diff -- este WHERE es el que protege el
-- soft-delete (una versión de anamnesis o un ítem de catálogo borrado
-- lógicamente no debe bloquear el número/código para uno nuevo).
CREATE UNIQUE INDEX "mhv_tenant_patient_version_key" ON "medical_history_versions"("tenantId", "patientId", "version") WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "catalog_tenant_code_key" ON "dental_catalog_items"("tenantId", "code") WHERE "deletedAt" IS NULL;

-- Habilitar RLS y forzarla incluso para el owner de la tabla (mismo patrón
-- que 20260722125715_rls_clinic_memberships / 20260722185208_add_patients),
-- para las 3 tablas de esta migración.
ALTER TABLE "medical_history_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "medical_history_versions" FORCE ROW LEVEL SECURITY;

ALTER TABLE "clinical_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clinical_entries" FORCE ROW LEVEL SECURITY;

ALTER TABLE "dental_catalog_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dental_catalog_items" FORCE ROW LEVEL SECURITY;

-- Aislamiento por tenant: solo filas del tenant en contexto.
-- current_setting(..., true) => NULL si no hay contexto => 0 filas (fail-safe).
CREATE POLICY tenant_isolation ON "medical_history_versions"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation ON "clinical_entries"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation ON "dental_catalog_items"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

-- Grants: no se requiere GRANT explícito aquí. Esta migración corre con el
-- rol owner "dentalix" (via DIRECT_URL), y
-- `ALTER DEFAULT PRIVILEGES FOR ROLE dentalix IN SCHEMA public` (ver
-- docker/db-init/01-app-role.sql) ya otorga SELECT/INSERT/UPDATE/DELETE
-- sobre toda tabla nueva creada por "dentalix" al rol de la app
-- (dentalix_app), igual que ocurrió para clinic_memberships/patients.
