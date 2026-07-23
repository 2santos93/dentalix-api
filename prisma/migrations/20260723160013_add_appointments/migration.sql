-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "reason" TEXT,
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "appointments_tenantId_providerId_start_idx" ON "appointments"("tenantId", "providerId", "start");

-- CreateIndex
CREATE INDEX "appointments_tenantId_patientId_idx" ON "appointments"("tenantId", "patientId");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Nota: `prisma migrate diff` también re-lista las CREATE UNIQUE INDEX de
-- catalog_tenant_code_key / mhv_tenant_patient_version_key / patients_tenant_doc_key
-- / tenants_subdomain_key / users_email_key sin su WHERE parcial (Prisma no
-- representa índices parciales). Esas ya existen correctamente en la DB
-- (con su WHERE "deletedAt" IS NULL); se omiten aquí a propósito -- no son
-- parte de este cambio y recrearlas sin el filtro rompería el soft-delete.
-- Mismo patrón documentado en 20260722222530_add_clinical_history_and_dental_catalog
-- y 20260723102018_add_tooth_records.

-- Habilitar RLS y forzarla incluso para el owner de la tabla (mismo patrón
-- que las migraciones RLS previas).
ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;

-- Aislamiento por tenant: solo filas del tenant en contexto.
-- current_setting(..., true) => NULL si no hay contexto => 0 filas (fail-safe).
CREATE POLICY tenant_isolation ON "appointments"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

-- Grants: no se requiere GRANT explícito. Esta migración corre con el rol
-- owner "dentalix" (via DIRECT_URL), y
-- `ALTER DEFAULT PRIVILEGES FOR ROLE dentalix IN SCHEMA public` (ver
-- docker/db-init/01-app-role.sql) ya otorga SELECT/INSERT/UPDATE/DELETE
-- sobre toda tabla nueva creada por "dentalix" al rol de la app
-- (dentalix_app), igual que en migraciones anteriores.
