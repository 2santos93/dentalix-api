-- DX-375 (porción 2 de DX-367): cada abono congela la tasa con que se
-- convirtió y su fuente, para que el saldo no cambie cuando cambie la tasa.
--
-- Columnas nuevas de "payments", todas NULL y sin DEFAULT (ADD COLUMN sin
-- reescribir la tabla):
--   "exchangeRateCurrency" moneda a la que se convierte: la del plan, o la del
--                          saldo migrado. La escribe todo abono nuevo; NULL
--                          solo en los anteriores (relleno: 20261102120100) o
--                          de una réplica anterior, que no la conoce.
--   "exchangeRateFrom"     unidades de la moneda del abono por 1 USD,
--   "exchangeRateTo"       unidades de "exchangeRateCurrency" por 1 USD,
--                          tal como las dio la fuente (Decimal(18,8), como
--                          las tablas de tasas),
--   "exchangeRateSource"   AUTOMATIC o MANUAL (DX-374),
--   "exchangeRateDate"     día civil de la tasa (el del abono en su sede).
-- Las cuatro de la tasa van juntas y solo cuando la moneda del abono es otra
-- (CHECK payments_exchange_rate_check). La moneda de destino es del catálogo
-- (FK payments_exchange_rate_currency_fkey). Los dos van NOT VALID: el CHECK
-- se valida en 20261102120400, sin bloquear las escrituras; la FK se queda
-- NOT VALID (comprueba toda fila nueva o cambiada; ver 20261102120400).
--
-- Compatible hacia atrás: una réplica anterior no selecciona ni escribe las
-- columnas nuevas (Prisma solo nombra las de su esquema), y sus abonos nacen
-- con todas NULL, que la API nueva lee como antes y el barrido congela.
--
-- Tasa manual usada: la app pasa a tener UPDATE solo de "rate" en
-- "manual_exchange_rates" (corregir una tasa que ningún abono usó) y un
-- trigger rechaza el cambio de una tasa que ya congeló algún abono, aunque la
-- API lo compruebe antes (409). El UPDATE de la columna también da a la app el
-- FOR SHARE con que el alta del abono confirma la tasa manual que congela.
--
-- ADD COLUMN, ADD CONSTRAINT NOT VALID y CREATE TRIGGER toman un ACCESS
-- EXCLUSIVE breve, sin leer la tabla. lock_timeout 5 s: si una transacción
-- larga lo retiene, falla limpia; para reintentar, `npx prisma migrate
-- resolve --rolled-back 20261102120000_dx375_payment_exchange_rate` y de nuevo
-- el deploy. RLS FORCE no se toca.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "payments"
  ADD COLUMN "exchangeRateCurrency" TEXT,
  ADD COLUMN "exchangeRateFrom" DECIMAL(18,8),
  ADD COLUMN "exchangeRateTo" DECIMAL(18,8),
  ADD COLUMN "exchangeRateSource" "ExchangeRateSource",
  ADD COLUMN "exchangeRateDate" DATE;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_exchange_rate_check" CHECK (
    (
      "exchangeRateFrom" IS NULL AND "exchangeRateTo" IS NULL
      AND "exchangeRateSource" IS NULL AND "exchangeRateDate" IS NULL
    )
    OR (
      "exchangeRateFrom" > 0 AND "exchangeRateTo" > 0
      AND "exchangeRateSource" IS NOT NULL AND "exchangeRateDate" IS NOT NULL
      AND "exchangeRateCurrency" IS NOT NULL
      AND "exchangeRateCurrency" <> "currency"
    )
  ) NOT VALID;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_exchange_rate_currency_fkey"
  FOREIGN KEY ("exchangeRateCurrency") REFERENCES "currencies"("code")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

GRANT UPDATE ("rate") ON "manual_exchange_rates" TO dentalix_app;

-- Una tasa manual la usa un abono que congeló una tasa MANUAL de ese día con
-- esa moneda, como moneda del abono o como moneda de destino. Lee "payments"
-- con la RLS de quien actualiza: la clínica de la tasa.
CREATE FUNCTION public.dx_manual_exchange_rate_in_use_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."rate" IS DISTINCT FROM OLD."rate" AND EXISTS (
    SELECT 1 FROM public."payments" p
     WHERE p."tenantId" = OLD."tenantId"
       AND p."exchangeRateSource" = 'MANUAL'::public."ExchangeRateSource"
       AND p."exchangeRateDate" = OLD."date"
       AND (p."currency" = OLD."currency"
            OR p."exchangeRateCurrency" = OLD."currency")
  ) THEN
    RAISE EXCEPTION 'La tasa manual ya la usa un abono y no se puede cambiar (DX-375)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "manual_exchange_rates_in_use_guard"
  BEFORE UPDATE ON "manual_exchange_rates"
  FOR EACH ROW EXECUTE FUNCTION public.dx_manual_exchange_rate_in_use_guard();
