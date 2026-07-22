-- CreateEnum
CREATE TYPE "DocType" AS ENUM ('CC', 'TI', 'CE', 'PASSPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "Sex" AS ENUM ('M', 'F', 'OTHER', 'UNSPECIFIED');

-- CreateTable
CREATE TABLE "patients" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "docType" "DocType" NOT NULL DEFAULT 'CC',
    "docNumber" TEXT,
    "birthDate" TIMESTAMP(3),
    "sex" "Sex" NOT NULL DEFAULT 'UNSPECIFIED',
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "patients_tenantId_idx" ON "patients"("tenantId");

-- Único parcial (soft-delete safe): mismo patrón que
-- 20260722184531_partial_unique_indexes. Prisma no puede expresar el WHERE
-- en el DSL, así que este índice se gestiona a mano; un futuro
-- `prisma migrate dev` no debería tocarlo (no hay @unique en schema.prisma
-- para docNumber).
CREATE UNIQUE INDEX "patients_tenant_doc_key" ON "patients"("tenantId", "docNumber") WHERE "deletedAt" IS NULL AND "docNumber" IS NOT NULL;

-- Habilitar RLS y forzarla incluso para el owner de la tabla (mismo patrón
-- que 20260722125715_rls_clinic_memberships).
ALTER TABLE "patients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patients" FORCE ROW LEVEL SECURITY;

-- Aislamiento por tenant: solo filas del tenant en contexto.
-- current_setting(..., true) => NULL si no hay contexto => 0 filas (fail-safe).
CREATE POLICY tenant_isolation ON "patients"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

-- Grants: no se requiere GRANT explícito aquí. Esta migración corre con el
-- rol owner "dentalix" (via DIRECT_URL), y
-- `ALTER DEFAULT PRIVILEGES FOR ROLE dentalix IN SCHEMA public` (ver
-- docker/db-init/01-app-role.sql) ya otorga SELECT/INSERT/UPDATE/DELETE
-- sobre toda tabla nueva creada por "dentalix" al rol de la app
-- (dentalix_app), igual que ocurrió para clinic_memberships. Verificado en
-- el paso de verificación (información en el reporte de esta tarea).
