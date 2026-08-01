-- MULTI-SEDE, fase 1 (docs/plans/2026-08-01-multi-sede.md).
-- La sede es una dimensión de filtrado DENTRO del tenant, no un nivel de
-- seguridad nuevo: el aislamiento duro lo sigue dando el RLS por tenant.
CREATE TABLE "locations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "locations_tenantId_idx" ON "locations"("tenantId");

-- RLS igual que cualquier tabla de dominio (mismo patrón que treatment_plans).
ALTER TABLE "locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "locations"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

-- Cada clínica existente estrena UNA sede principal: hasta la fase 2 nada
-- cambia de comportamiento, todo queda apuntando aquí.
INSERT INTO "locations" ("id", "tenantId", "name", "createdAt", "updatedAt")
SELECT gen_random_uuid(), t."id", 'Sede principal', now(), now()
FROM "tenants" t
WHERE t."deletedAt" IS NULL;

-- locationId en las tablas OPERATIVAS (lo que ocurre en un sitio físico).
-- Patient / catálogo / historia NO lo llevan: la ficha del paciente es de la
-- clínica, no de la sede — ese es el punto del modelo elegido.
ALTER TABLE "appointments" ADD COLUMN "locationId" UUID;
ALTER TABLE "payments" ADD COLUMN "locationId" UUID;
ALTER TABLE "inventory_items" ADD COLUMN "locationId" UUID;
ALTER TABLE "inventory_movements" ADD COLUMN "locationId" UUID;

-- Backfill: cada fila hereda la sede principal DE SU PROPIO tenant.
UPDATE "appointments" a SET "locationId" = l."id"
  FROM "locations" l WHERE l."tenantId" = a."tenantId";
UPDATE "payments" p SET "locationId" = l."id"
  FROM "locations" l WHERE l."tenantId" = p."tenantId";
UPDATE "inventory_items" i SET "locationId" = l."id"
  FROM "locations" l WHERE l."tenantId" = i."tenantId";
UPDATE "inventory_movements" m SET "locationId" = l."id"
  FROM "locations" l WHERE l."tenantId" = m."tenantId";

-- Recién ahora NOT NULL: si algún backfill hubiera dejado filas sueltas, esto
-- falla y aborta la migración en vez de dejar datos a medias.
ALTER TABLE "appointments" ALTER COLUMN "locationId" SET NOT NULL;
ALTER TABLE "payments" ALTER COLUMN "locationId" SET NOT NULL;
ALTER TABLE "inventory_items" ALTER COLUMN "locationId" SET NOT NULL;
ALTER TABLE "inventory_movements" ALTER COLUMN "locationId" SET NOT NULL;

ALTER TABLE "appointments" ADD CONSTRAINT "appointments_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "appointments_tenantId_locationId_idx" ON "appointments"("tenantId", "locationId");
CREATE INDEX "payments_tenantId_locationId_idx" ON "payments"("tenantId", "locationId");
CREATE INDEX "inventory_items_tenantId_locationId_idx" ON "inventory_items"("tenantId", "locationId");
