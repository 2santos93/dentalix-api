-- CreateTable
CREATE TABLE "exchange_rate_snapshots" (
    "id" UUID NOT NULL,
    "date" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rate_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rate_snapshots_date_currency_key" ON "exchange_rate_snapshots"("date", "currency");

-- Nota: `prisma migrate diff` también re-lista las CREATE UNIQUE INDEX de
-- catalog_tenant_code_key / mhv_tenant_patient_version_key / patients_tenant_doc_key
-- / tenants_subdomain_key / users_email_key sin su WHERE parcial (Prisma no
-- representa índices parciales). Esas ya existen correctamente en la DB
-- (con su WHERE "deletedAt" IS NULL); se omiten aquí a propósito -- no son
-- parte de este cambio y recrearlas sin el filtro rompería el soft-delete.
-- Mismo patrón documentado en 20260722222530_add_clinical_history_and_dental_catalog,
-- 20260723102018_add_tooth_records, 20260723160013_add_appointments y
-- 20260724120000_add_treatment_plans.

-- SIN RLS (a propósito): a diferencia de TODAS las demás tablas de dominio
-- de este esquema (multi-tenant, aisladas por `tenantId` con policy
-- `tenant_isolation`), `exchange_rate_snapshots` es un catálogo de
-- referencia/mercado GLOBAL: la tasa USD->COP del 2026-07-24 es la misma
-- para todos los tenants, no pertenece a ninguno. No lleva `tenantId`, no
-- lleva `deletedAt` (snapshot inmutable, una fila por fecha+moneda, se
-- upsertea pero nunca se "borra" para un tenant en particular), y por lo
-- tanto NO se habilita `ROW LEVEL SECURITY` aquí -- no hay nada que aislar
-- por tenant. Es la misma excepción técnica que cache/colas/sesiones
-- documentada en la regla de soft-delete del repo (tablas puramente
-- técnicas/de referencia, no de dominio).
