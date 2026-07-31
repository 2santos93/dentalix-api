-- CreateEnum
CREATE TYPE "PaymentPlanStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InstallmentPeriodicity" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY');

-- CreateTable
CREATE TABLE "payment_plans" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "treatmentPlanId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "currency" TEXT NOT NULL,
    "totalToFinance" DECIMAL(14,2) NOT NULL,
    "downPayment" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "installmentsCount" INTEGER NOT NULL,
    "periodicity" "InstallmentPeriodicity" NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "status" "PaymentPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "payment_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installments" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "paymentPlanId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_plans_tenantId_treatmentPlanId_idx" ON "payment_plans"("tenantId", "treatmentPlanId");

-- CreateIndex
CREATE INDEX "payment_plans_tenantId_patientId_idx" ON "payment_plans"("tenantId", "patientId");

-- CreateIndex
CREATE INDEX "installments_tenantId_dueDate_idx" ON "installments"("tenantId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "installments_paymentPlanId_sequence_key" ON "installments"("paymentPlanId", "sequence");

-- AddForeignKey
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_treatmentPlanId_fkey" FOREIGN KEY ("treatmentPlanId") REFERENCES "treatment_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installments" ADD CONSTRAINT "installments_paymentPlanId_fkey" FOREIGN KEY ("paymentPlanId") REFERENCES "payment_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Habilitar RLS y forzarla incluso para el owner de la tabla (mismo patrón
-- que 20260724120000_add_treatment_plans).
ALTER TABLE "payment_plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_plans" FORCE ROW LEVEL SECURITY;
ALTER TABLE "installments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "installments" FORCE ROW LEVEL SECURITY;

-- Aislamiento por tenant: solo filas del tenant en contexto.
-- current_setting(..., true) => NULL si no hay contexto => 0 filas (fail-safe).
CREATE POLICY tenant_isolation ON "payment_plans"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation ON "installments"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
