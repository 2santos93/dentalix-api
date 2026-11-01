-- DX-502: la moneda del catálogo, congelada en el ítem del plan.
--
-- El precio de lista del presupuesto es el `defaultPrice` del catálogo
-- ("basePrice" del ítem, DX-105), que no lleva moneda. Hasta ahora la web la
-- deducía al pintar de las sedes ACTUALES, así que la página pública (sin
-- sedes) lo pintaba con la moneda del plan y un presupuesto firmado podía
-- cambiar de moneda si luego cambiaban las sedes.
--
-- Cambios:
--   treatment_plan_items  columna NULL "catalogCurrency" CHAR(3): la moneda
--                         del catálogo (la común de las sedes activas) al
--                         dar de alta el ítem; NULL si no había una común o
--                         el ítem no tiene precio de catálogo. FK a
--                         currencies NOT VALID (la valida
--                         20261111180200_dx502_plan_item_catalog_currency_fk_validate).
--   trigger nuevo         treatment_plan_items_catalog_currency_frozen: una
--                         vez escrita, la moneda no cambia ni se borra (sí se
--                         rellena una vez, desde NULL).
--   trigger existente     treatment_plan_items_locked_when_closed (versión de
--                         20261024150400_sec050_void_fee_in_closed_plan, sin
--                         más cambios) admite en un plan cerrado ese relleno
--                         único y nada más de la fila. Sin él, el relleno de
--                         20261111180100 fallaría en los ítems de planes
--                         completados, rechazados o cancelados.
--                         treatment_plans_locked_when_accepted y
--                         treatment_plan_items_locked_when_accepted no miran
--                         la columna; la congela el trigger nuevo.
--
-- Compatible hacia atrás: columna NULL sin DEFAULT (solo catálogo, no
-- reescribe la tabla) que el código anterior no lee ni escribe; la FK NOT
-- VALID no recorre filas. Ningún importe cambia.
--
-- Vuelta atrás (sin pérdida de importes): DROP TRIGGER
-- "treatment_plan_items_catalog_currency_frozen" ON "treatment_plan_items";
-- DROP FUNCTION public."treatment_plan_items_catalog_currency_frozen"();
-- ALTER TABLE "treatment_plan_items" DROP COLUMN "catalogCurrency"; y la
-- función de 20261024150400 tal cual.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "treatment_plan_items" ADD COLUMN "catalogCurrency" CHAR(3);

ALTER TABLE "treatment_plan_items" ADD CONSTRAINT "treatment_plan_items_catalog_currency_fkey"
  FOREIGN KEY ("catalogCurrency") REFERENCES "currencies"("code")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

CREATE FUNCTION public."treatment_plan_items_catalog_currency_frozen"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD."catalogCurrency" IS NOT NULL
     AND NEW."catalogCurrency" IS DISTINCT FROM OLD."catalogCurrency" THEN
    RAISE EXCEPTION 'la moneda del catálogo del ítem queda fijada al darlo de alta: no cambia'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "treatment_plan_items_catalog_currency_frozen"
  BEFORE UPDATE OF "catalogCurrency" ON "treatment_plan_items"
  FOR EACH ROW EXECUTE FUNCTION public."treatment_plan_items_catalog_currency_frozen"();

CREATE OR REPLACE FUNCTION public."treatment_plan_items_locked_when_closed"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  plan_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD."planId" ELSE NEW."planId" END;
  plan_status text;
  attribution text[] := ARRAY['performedById', 'performedByMembershipId',
                              'performedLocationId', 'completedAt', 'updatedAt'];
BEGIN
  IF coalesce(current_setting('app.current_tenant', true), '') = '' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  SELECT p."status"::text INTO plan_status
    FROM public."treatment_plans" p WHERE p."id" = plan_id FOR SHARE;
  IF plan_status IN ('CANCELLED', 'REJECTED', 'COMPLETED') THEN
    IF TG_OP = 'UPDATE'
       AND plan_status = 'COMPLETED'
       AND OLD."status"::text = 'ACCEPTED'
       AND NEW."status"::text = 'DONE'
       AND NEW."planId" IS NOT DISTINCT FROM OLD."planId"
       AND NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId"
       AND NEW."toothNumber" IS NOT DISTINCT FROM OLD."toothNumber"
       AND NEW."surfaces" IS NOT DISTINCT FROM OLD."surfaces"
       AND NEW."catalogItemId" IS NOT DISTINCT FROM OLD."catalogItemId"
       AND NEW."catalogPrice" IS NOT DISTINCT FROM OLD."catalogPrice"
       AND NEW."basePrice" IS NOT DISTINCT FROM OLD."basePrice"
       AND NEW."priceSource" IS NOT DISTINCT FROM OLD."priceSource"
       AND NEW."agreementId" IS NOT DISTINCT FROM OLD."agreementId"
       AND NEW."agreementName" IS NOT DISTINCT FROM OLD."agreementName"
       AND NEW."pricingLocationId" IS NOT DISTINCT FROM OLD."pricingLocationId"
       AND NEW."price" IS NOT DISTINCT FROM OLD."price"
       AND NEW."discount" IS NOT DISTINCT FROM OLD."discount"
       AND NEW."discountReason" IS NOT DISTINCT FROM OLD."discountReason"
       AND NEW."discountReasonNote" IS NOT DISTINCT FROM OLD."discountReasonNote"
       AND NEW."discountById" IS NOT DISTINCT FROM OLD."discountById"
       AND NEW."discountAt" IS NOT DISTINCT FROM OLD."discountAt"
       AND NEW."discountLocationId" IS NOT DISTINCT FROM OLD."discountLocationId"
       AND NEW."notes" IS NOT DISTINCT FROM OLD."notes"
       AND NEW."deletedAt" IS NOT DISTINCT FROM OLD."deletedAt" THEN
      RETURN NEW;
    END IF;
    -- SEC-050: retirar el ítem de un cargo por inasistencia ya anulado.
    IF TG_OP = 'UPDATE'
       AND OLD."deletedAt" IS NULL
       AND NEW."deletedAt" IS NOT NULL
       AND (to_jsonb(NEW) - ARRAY['deletedAt', 'updatedAt'])
           = (to_jsonb(OLD) - ARRAY['deletedAt', 'updatedAt'])
       AND EXISTS (
         SELECT 1
           FROM public."cancellation_fees" f
          WHERE f."tenantId" = OLD."tenantId"
            AND f."patientId" = OLD."patientId"
            AND f."planItemId" = OLD."id"
            AND f."status" = 'CHARGED'
            AND f."voidedAt" IS NOT NULL
       ) THEN
      RETURN NEW;
    END IF;
    -- DX-502: rellenar UNA vez la moneda del catálogo de un ítem que no la
    -- tenía (el relleno de la migración), sin tocar nada más de la fila.
    IF TG_OP = 'UPDATE'
       AND OLD."catalogCurrency" IS NULL
       AND (to_jsonb(NEW) - ARRAY['catalogCurrency', 'updatedAt'])
           = (to_jsonb(OLD) - ARRAY['catalogCurrency', 'updatedAt']) THEN
      RETURN NEW;
    END IF;
    -- DX-050: corregir quién o cuándo de un ítem ya REALIZADO.
    IF TG_OP = 'UPDATE'
       AND OLD."status"::text = 'DONE'
       AND NEW."status"::text = 'DONE'
       AND (to_jsonb(NEW) - attribution) = (to_jsonb(OLD) - attribution) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'el plan está cerrado: sus ítems no se añaden, cambian ni retiran'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
