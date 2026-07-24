-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('IN', 'OUT', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "unit" TEXT NOT NULL,
    "minStock" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "type" "InventoryMovementType" NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "reason" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_items_tenantId_idx" ON "inventory_items"("tenantId");

-- CreateIndex
CREATE INDEX "inventory_movements_tenantId_itemId_idx" ON "inventory_movements"("tenantId", "itemId");

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Nota: `prisma migrate diff` también re-lista las CREATE UNIQUE INDEX de
-- catalog_tenant_code_key / mhv_tenant_patient_version_key / patients_tenant_doc_key
-- / tenants_subdomain_key / users_email_key sin su WHERE parcial (Prisma no
-- representa índices parciales). Esas ya existen correctamente en la DB
-- (con su WHERE "deletedAt" IS NULL); se omiten aquí a propósito -- no son
-- parte de este cambio y recrearlas sin el filtro rompería el soft-delete.
-- Mismo patrón documentado en 20260722222530_add_clinical_history_and_dental_catalog,
-- 20260723102018_add_tooth_records, 20260723160013_add_appointments,
-- 20260724120000_add_treatment_plans y 20260724140000_add_sales.

-- Nota: FK inventory_movements_itemId_fkey usa ON DELETE RESTRICT porque los
-- movimientos son un registro histórico inmutable ligado a un ítem existente
-- (mismo patrón que sale_line_items_saleId_fkey) -- un ítem con movimientos
-- no puede borrarse físicamente (soft-delete vía deletedAt en InventoryItem).

-- Habilitar RLS y forzarla incluso para el owner de la tabla (mismo patrón
-- que las migraciones RLS previas).
ALTER TABLE "inventory_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_items" FORCE ROW LEVEL SECURITY;
ALTER TABLE "inventory_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_movements" FORCE ROW LEVEL SECURITY;

-- Aislamiento por tenant: solo filas del tenant en contexto.
-- current_setting(..., true) => NULL si no hay contexto => 0 filas (fail-safe).
CREATE POLICY tenant_isolation ON "inventory_items"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation ON "inventory_movements"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

-- Grants: no se requiere GRANT explícito. Esta migración corre con el rol
-- owner "dentalix" (via DIRECT_URL), y
-- `ALTER DEFAULT PRIVILEGES FOR ROLE dentalix IN SCHEMA public` (ver
-- docker/db-init/01-app-role.sql) ya otorga SELECT/INSERT/UPDATE/DELETE
-- sobre toda tabla nueva creada por "dentalix" al rol de la app
-- (dentalix_app), igual que en migraciones anteriores.
