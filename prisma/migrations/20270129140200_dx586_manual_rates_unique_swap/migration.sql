-- DX-586: cierra el relleno de "effectiveFrom"
-- (20270129140100_dx586_effective_from_backfill) y cambia la unicidad de las
-- tasas manuales: de una por (clínica, día, moneda) a una por (clínica,
-- moneda, instante desde el que rige). Así una clínica registra varias el
-- mismo día («desde las 14:30»).
--
-- VALIDATE del CHECK (NOT NULL) ve todas las filas aunque el owner esté
-- sujeto a la RLS (DX-134): si quedara alguna sin relleno, falla de forma
-- ruidosa. Con el CHECK validado, SET NOT NULL no recorre la tabla; el CHECK
-- se quita después (lo cubre el NOT NULL).
--
-- El cambio de índice va en la MISMA transacción: primero el único nuevo y el
-- índice de lectura por día, después se quita el único viejo; no hay un
-- instante sin unicidad. Sin CONCURRENTLY: "manual_exchange_rates" es pequeña
-- (no es tabla caliente) y el SHARE dura lo que el CREATE INDEX (molde de
-- 20261216090200_dx467_prescription_verification_code_validate).
--
-- lock_timeout 5 s; para reintentar, `prisma migrate resolve --rolled-back
-- 20270129140200_dx586_manual_rates_unique_swap` y `deploy`.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "manual_exchange_rates" VALIDATE CONSTRAINT "manual_exchange_rates_effective_from_check";
ALTER TABLE "manual_exchange_rates" ALTER COLUMN "effectiveFrom" SET NOT NULL;
ALTER TABLE "manual_exchange_rates" DROP CONSTRAINT "manual_exchange_rates_effective_from_check";

CREATE UNIQUE INDEX "manual_exchange_rates_tenant_currency_effective_key"
  ON "manual_exchange_rates"("tenantId", "currency", "effectiveFrom");
CREATE INDEX "manual_exchange_rates_tenant_date_currency_idx"
  ON "manual_exchange_rates"("tenantId", "date", "currency", "effectiveFrom");
DROP INDEX "manual_exchange_rates_tenant_date_currency_key";
