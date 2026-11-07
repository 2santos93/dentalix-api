-- DX-513-bis: la referencia de la rebaja de un ítem, congelada en la moneda
-- del plan.
--
-- Con el catálogo en otra moneda conocida (p. ej. catálogo en USD fijado por
-- la clínica y plan en VES), DX-513 dejaba de medir la rebaja: el tope por
-- rol, el motivo y el informe de descuentos no la veían. Ahora el caso de uso
-- convierte la referencia a la moneda del plan con la tasa de la clínica del
-- día de la sede al escribir el ítem y la congela en él, con la tasa (como
-- un abono, DX-375). El informe lee la foto: nunca convierte al consultar.
--
-- Columnas nuevas de "treatment_plan_items", todas NULL y sin DEFAULT (ADD
-- COLUMN sin reescribir la tabla), sin relleno:
--   "referenceCurrency"    moneda de "catalogPrice" al escribirlo (la del plan
--                          para las listas; la del catálogo para el resto;
--                          NULL si no se supo). FK a currencies NOT VALID (la
--                          valida 20261201090100).
--   "referencePriceInPlan" "catalogPrice" en la moneda del plan.
--   "basePriceInPlan"      "basePrice" en la moneda del plan.
--   "referenceRateFrom",   unidades por 1 USD de "referenceCurrency" y de la
--   "referenceRateTo"      moneda del plan (Decimal(18,8), como los abonos),
--   "referenceRateSource"  AUTOMATIC o MANUAL (DX-374),
--   "referenceRateDate"    día civil de la tasa usada (DX-384).
-- Las cuatro de la tasa van juntas, con la referencia y su moneda (CHECK
-- treatment_plan_items_reference_rate_check); los importes, >= 0 y solo con
-- "catalogPrice" (CHECK treatment_plan_items_reference_price_check). Los dos
-- NOT VALID: los valida 20261201090100 sin bloquear las escrituras.
--
-- Trigger nuevo treatment_plan_items_reference_frozen: una vez escrita, la
-- foto no cambia; solo se permite pasar de NULL a un valor (un ítem anterior
-- la toma en su primera rebaja). treatment_plan_items_locked_when_accepted y
-- treatment_plan_items_locked_when_closed no cambian: la app no escribe la
-- foto en un plan firmado ni cerrado (no admiten cambios de descuento).
--
-- Compatible hacia atrás: una réplica anterior no lee ni escribe estas
-- columnas (Prisma solo nombra las de su esquema) y sus ítems nacen sin foto,
-- que la API nueva trata como anteriores. Ningún importe guardado cambia.
-- RLS FORCE no se toca; no hace falta superusuario.
--
-- ADD COLUMN, ADD CONSTRAINT NOT VALID y CREATE TRIGGER toman un ACCESS
-- EXCLUSIVE breve, sin leer la tabla. lock_timeout 5 s: si falla, `npx prisma
-- migrate resolve --rolled-back 20261201090000_dx513b_plan_item_reference_snapshot`
-- y de nuevo el deploy.
--
-- Vuelta atrás (sin pérdida de importes): DROP TRIGGER
-- "treatment_plan_items_reference_frozen" ON "treatment_plan_items"; DROP
-- FUNCTION public."treatment_plan_items_reference_frozen"(); y DROP COLUMN de
-- las siete columnas (con sus CHECK y la FK).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "treatment_plan_items"
  ADD COLUMN "referenceCurrency" CHAR(3),
  ADD COLUMN "referencePriceInPlan" DECIMAL(12,2),
  ADD COLUMN "basePriceInPlan" DECIMAL(12,2),
  ADD COLUMN "referenceRateFrom" DECIMAL(18,8),
  ADD COLUMN "referenceRateTo" DECIMAL(18,8),
  ADD COLUMN "referenceRateSource" "ExchangeRateSource",
  ADD COLUMN "referenceRateDate" DATE;

ALTER TABLE "treatment_plan_items"
  ADD CONSTRAINT "treatment_plan_items_reference_rate_check" CHECK (
    (
      "referenceRateFrom" IS NULL AND "referenceRateTo" IS NULL
      AND "referenceRateSource" IS NULL AND "referenceRateDate" IS NULL
    )
    OR (
      "referenceRateFrom" > 0 AND "referenceRateTo" > 0
      AND "referenceRateSource" IS NOT NULL AND "referenceRateDate" IS NOT NULL
      AND "referenceCurrency" IS NOT NULL
      AND "referencePriceInPlan" IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE "treatment_plan_items"
  ADD CONSTRAINT "treatment_plan_items_reference_price_check" CHECK (
    ("referencePriceInPlan" IS NULL OR ("referencePriceInPlan" >= 0 AND "catalogPrice" IS NOT NULL))
    AND ("basePriceInPlan" IS NULL OR ("basePriceInPlan" >= 0 AND "basePrice" IS NOT NULL))
  ) NOT VALID;

ALTER TABLE "treatment_plan_items" ADD CONSTRAINT "treatment_plan_items_reference_currency_fkey"
  FOREIGN KEY ("referenceCurrency") REFERENCES "currencies"("code")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

CREATE FUNCTION public."treatment_plan_items_reference_frozen"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- Una foto ya escrita (alguna columna no NULL) no cambia ni se borra.
  IF num_nonnulls(OLD."referenceCurrency", OLD."referencePriceInPlan",
                  OLD."basePriceInPlan", OLD."referenceRateFrom",
                  OLD."referenceRateTo", OLD."referenceRateSource",
                  OLD."referenceRateDate") > 0
     AND (NEW."referenceCurrency", NEW."referencePriceInPlan",
          NEW."basePriceInPlan", NEW."referenceRateFrom",
          NEW."referenceRateTo", NEW."referenceRateSource",
          NEW."referenceRateDate")
         IS DISTINCT FROM
         (OLD."referenceCurrency", OLD."referencePriceInPlan",
          OLD."basePriceInPlan", OLD."referenceRateFrom",
          OLD."referenceRateTo", OLD."referenceRateSource",
          OLD."referenceRateDate") THEN
    RAISE EXCEPTION 'la referencia del ítem en la moneda del plan queda fijada al escribirla: no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "treatment_plan_items_reference_frozen"
  BEFORE UPDATE OF "referenceCurrency", "referencePriceInPlan", "basePriceInPlan",
                   "referenceRateFrom", "referenceRateTo", "referenceRateSource",
                   "referenceRateDate"
  ON "treatment_plan_items"
  FOR EACH ROW EXECUTE FUNCTION public."treatment_plan_items_reference_frozen"();
