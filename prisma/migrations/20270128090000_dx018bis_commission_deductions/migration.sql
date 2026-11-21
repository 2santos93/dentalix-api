-- DX-018-bis: los datos de origen de los descuentos de honorarios.
--
--   1. Costo de la orden de laboratorio (importe + moneda, los dos o ninguno).
--      Lo pone ADMIN en cualquier estado salvo anulada: el guard de DX-017
--      admite cambiarlo tras «Enviada» (el laboratorio factura al entregar).
--   2. % de comisión de la pasarela por medio de pago (lo que la pasarela
--      cobra a la CLÍNICA; no es un ajuste al paciente de DX-516).
--   3. La regla de honorarios guarda deductLabCost/deductCardFee; la
--      liquidación los congela en la cabecera, y cada línea su base bruta y
--      lo descontado (base = bruta − laboratorio − pasarela).
--
-- Todo aditivo: columnas NULL o NOT NULL DEFAULT constante (sin reescribir
-- la tabla en Postgres ≥ 11). El código anterior no las lee; sus INSERT
-- reciben los defaults. Las líneas anteriores quedan con grossBase NULL
-- (= base, sin descuentos).
--
-- Vuelta atrás:
--   ALTER TABLE "commission_settlement_lines"
--     DROP CONSTRAINT "commission_settlement_lines_deductions_check",
--     DROP COLUMN "grossBase", DROP COLUMN "labCostDeducted",
--     DROP COLUMN "cardFeePercent", DROP COLUMN "cardFeeDeducted",
--     DROP COLUMN "labCostSkippedCurrencies";
--   ALTER TABLE "commission_settlements" DROP COLUMN "deductLabCost", DROP COLUMN "deductCardFee";
--   ALTER TABLE "commission_rules" DROP COLUMN "deductLabCost", DROP COLUMN "deductCardFee";
--   ALTER TABLE "payment_methods" DROP CONSTRAINT "payment_methods_gateway_fee_check",
--     DROP COLUMN "gatewayFeePercent";
--   DROP INDEX "dental_lab_orders_cost_currency_idx";
--   ALTER TABLE "dental_lab_orders" DROP CONSTRAINT "dental_lab_orders_cost_check",
--     DROP CONSTRAINT "dental_lab_orders_cost_currency_fkey",
--     DROP COLUMN "cost", DROP COLUMN "costCurrency";
--   y la función dx_dental_lab_orders_guard de 20261230170200 (sin cost/costCurrency).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Costo de la orden de laboratorio
-- ---------------------------------------------------------------------------

ALTER TABLE "dental_lab_orders"
  ADD COLUMN "cost" DECIMAL(14,2),
  ADD COLUMN "costCurrency" CHAR(3);
ALTER TABLE "dental_lab_orders" ADD CONSTRAINT "dental_lab_orders_cost_check" CHECK (
  ("cost" IS NULL) = ("costCurrency" IS NULL) AND ("cost" IS NULL OR "cost" >= 0)
);
-- DX-134: sin FORCE mientras se añade la FK (currencies no tiene RLS).
ALTER TABLE "dental_lab_orders" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "dental_lab_orders" ADD CONSTRAINT "dental_lab_orders_cost_currency_fkey"
  FOREIGN KEY ("costCurrency") REFERENCES "currencies"("code")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dental_lab_orders" FORCE ROW LEVEL SECURITY;
-- Lado hijo de la FK a la moneda (como dental_lab_services_currency_idx).
CREATE INDEX "dental_lab_orders_cost_currency_idx" ON "dental_lab_orders"("costCurrency");

-- El guard de DX-017 con cost/costCurrency entre lo que cambia tras «Enviada».
-- Una anulada sigue sin cambiar (tampoco su costo).
CREATE OR REPLACE FUNCTION public.dx_dental_lab_orders_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  after_sent_mutable text[] := ARRAY['dueOn', 'appointmentId', 'updatedAt',
    'receivedAt', 'receivedById', 'checkedAt', 'checkedById',
    'cancelledAt', 'cancelledById', 'cancelReason', 'cost', 'costCurrency'];
BEGIN
  -- DX-266: la fusión de pacientes solo reasigna el paciente (el resto de
  -- la fila no cambia): ver public.dx_patient_merge_gate.
  IF TG_OP = 'UPDATE' AND TG_LEVEL = 'ROW' AND public.dx_patient_merge_active() THEN
    IF public.dx_patient_merge_gate(TG_TABLE_NAME, pg_catalog.to_jsonb(OLD), pg_catalog.to_jsonb(NEW)) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'dental_lab_orders: una orden de laboratorio no se borra, se anula (DX-017)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."cancelledAt" IS NOT NULL THEN
    RAISE EXCEPTION 'dental_lab_orders: una orden anulada no se modifica (DX-017)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."locationId" IS DISTINCT FROM OLD."locationId"
     OR NEW."number" IS DISTINCT FROM OLD."number"
     OR NEW."professionalMembershipId" IS DISTINCT FROM OLD."professionalMembershipId"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'dental_lab_orders: la clínica, el paciente, la sede, el número, el profesional, el autor y la fecha de alta no cambian (DX-017)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD."sentAt" IS NOT NULL AND (NEW."sentAt" IS DISTINCT FROM OLD."sentAt" OR NEW."sentById" IS DISTINCT FROM OLD."sentById"))
     OR (OLD."receivedAt" IS NOT NULL AND (NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt" OR NEW."receivedById" IS DISTINCT FROM OLD."receivedById"))
     OR (OLD."checkedAt" IS NOT NULL AND (NEW."checkedAt" IS DISTINCT FROM OLD."checkedAt" OR NEW."checkedById" IS DISTINCT FROM OLD."checkedById")) THEN
    RAISE EXCEPTION 'dental_lab_orders: una fecha de envío, recepción o revisión no cambia ni se quita (DX-017)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."sentAt" IS NOT NULL
     AND (pg_catalog.to_jsonb(NEW) - after_sent_mutable) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - after_sent_mutable) THEN
    RAISE EXCEPTION 'dental_lab_orders: una orden enviada no cambia; se corrige con una orden nueva que la sustituya (DX-017)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."replacesOrderId" IS NOT NULL
     AND NEW."replacesOrderId" IS DISTINCT FROM OLD."replacesOrderId"
     AND NOT EXISTS (
       SELECT 1 FROM public."dental_lab_orders" o
        WHERE o."tenantId" = NEW."tenantId" AND o."id" = NEW."replacesOrderId"
          AND o."patientId" = NEW."patientId"
     ) THEN
    RAISE EXCEPTION 'dental_lab_orders: la orden corregida es de otro paciente (DX-017)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Comisión de la pasarela por medio de pago
-- ---------------------------------------------------------------------------

ALTER TABLE "payment_methods" ADD COLUMN "gatewayFeePercent" DECIMAL(5,2);
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_gateway_fee_check" CHECK (
  "gatewayFeePercent" IS NULL OR ("gatewayFeePercent" > 0 AND "gatewayFeePercent" <= 100)
);

-- ---------------------------------------------------------------------------
-- 3. Regla, cabecera y líneas de la liquidación
-- ---------------------------------------------------------------------------

ALTER TABLE "commission_rules"
  ADD COLUMN "deductLabCost" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "deductCardFee" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "commission_settlements"
  ADD COLUMN "deductLabCost" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "deductCardFee" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "commission_settlement_lines"
  ADD COLUMN "grossBase" DECIMAL(14,2),
  ADD COLUMN "labCostDeducted" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "cardFeePercent" DECIMAL(5,2),
  ADD COLUMN "cardFeeDeducted" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "labCostSkippedCurrencies" TEXT[] NOT NULL DEFAULT '{}';
-- Sin base bruta (líneas anteriores): sin descuentos. Con ella, la base es la
-- bruta menos lo descontado; un devengo descuenta importes no negativos.
ALTER TABLE "commission_settlement_lines" ADD CONSTRAINT "commission_settlement_lines_deductions_check" CHECK (
  ("cardFeePercent" IS NULL OR ("cardFeePercent" > 0 AND "cardFeePercent" <= 100))
  AND pg_catalog.array_position("labCostSkippedCurrencies", NULL) IS NULL
  AND CASE
    WHEN "grossBase" IS NULL THEN
      "labCostDeducted" = 0 AND "cardFeeDeducted" = 0 AND "cardFeePercent" IS NULL
    ELSE
      "grossBase" - "labCostDeducted" - "cardFeeDeducted" = "base"
      AND ("kind" = 'ADJUSTMENT' OR ("labCostDeducted" >= 0 AND "cardFeeDeducted" >= 0))
  END
);
