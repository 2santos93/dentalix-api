-- AlterTable: moneda del plan de tratamiento. El monto a pagar/saldo se
-- calculan en esta moneda; un abono en otra moneda se convierte por su
-- fecha (ver Payment / ConvertAmountUseCase). Default 'USD' para no romper
-- filas existentes.
ALTER TABLE "treatment_plans" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD';

-- CreateTable: Payment (abono contra un Plan de Tratamiento). Reemplaza
-- Sale/SaleLineItem -- ver docs/plans/2026-07-24-payments-pivot.md. Reusa el
-- enum "PaymentMethod" ya existente (creado en 20260724140000_add_sales),
-- que se conserva. `patientId` está denormalizado del plan (para listar
-- abonos por paciente sin join) y NO lleva FK propia -- solo `treatmentPlanId`
-- referencia `treatment_plans`, igual que el resto del modelo (el paciente
-- del plan es la fuente de verdad).
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "treatmentPlanId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "method" "PaymentMethod",
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payments_tenantId_treatmentPlanId_idx" ON "payments"("tenantId", "treatmentPlanId");

-- CreateIndex
CREATE INDEX "payments_tenantId_patientId_idx" ON "payments"("tenantId", "patientId");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_treatmentPlanId_fkey" FOREIGN KEY ("treatmentPlanId") REFERENCES "treatment_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Habilitar RLS y forzarla incluso para el owner de la tabla (mismo patrón
-- que las migraciones RLS previas).
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;

-- Aislamiento por tenant: solo filas del tenant en contexto.
-- current_setting(..., true) => NULL si no hay contexto => 0 filas (fail-safe).
CREATE POLICY tenant_isolation ON "payments"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

-- Eliminación deliberada de Sale/SaleLineItem (pivote Ventas -> Abonos, ver
-- docs/plans/2026-07-24-payments-pivot.md y docs/research/payments-analysis.md).
-- Sale/SaleLineItem fue la abstracción equivocada: los abonos se registran
-- contra un Plan de Tratamiento, no como "ventas" sueltas. Es un DROP
-- destructivo pero SEGURO: feature de dev, NUNCA usada en prod (0 filas en
-- prod). En DEV local hay únicamente datos de prueba desechables (4 sales /
-- 5 line items, confirmados antes de este drop). El enum "PaymentMethod" SE
-- CONSERVA -- lo reutiliza "payments". Orden de drop: line items primero
-- (FK hacia sales), luego sales.
DROP TABLE "sale_line_items";
DROP TABLE "sales";

-- Nota: `prisma migrate diff` también re-lista las CREATE UNIQUE INDEX de
-- catalog_tenant_code_key / mhv_tenant_patient_version_key / patients_tenant_doc_key
-- / tenants_subdomain_key / users_email_key sin su WHERE parcial (Prisma no
-- representa índices parciales). Esas ya existen correctamente en la DB
-- (con su WHERE "deletedAt" IS NULL); se omiten aquí a propósito -- no son
-- parte de este cambio y recrearlas sin el filtro rompería el soft-delete.
-- Mismo patrón documentado en 20260722222530_add_clinical_history_and_dental_catalog,
-- 20260723102018_add_tooth_records, 20260723160013_add_appointments,
-- 20260724120000_add_treatment_plans y 20260724140000_add_sales.

-- Grants: no se requiere GRANT explícito. Esta migración corre con el rol
-- owner "dentalix" (via DIRECT_URL), y
-- `ALTER DEFAULT PRIVILEGES FOR ROLE dentalix IN SCHEMA public` (ver
-- docker/db-init/01-app-role.sql) ya otorga SELECT/INSERT/UPDATE/DELETE
-- sobre toda tabla nueva creada por "dentalix" al rol de la app
-- (dentalix_app), igual que en migraciones anteriores.
