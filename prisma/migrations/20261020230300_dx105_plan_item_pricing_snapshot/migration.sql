-- DX-105: la foto del precio del ítem de plan (convenio / lista / catálogo).
--
-- Cambios:
--   treatment_plan_items   columnas NULL:
--                            "basePrice"         precio de catálogo en el momento
--                                                (ruling R1: "catalogPrice" pasa a
--                                                ser el precio de referencia
--                                                RESUELTO convenio → lista →
--                                                catálogo; así el descuento
--                                                discrecional y su informe siguen
--                                                midiendo solo lo que baja del
--                                                precio pactado);
--                            "priceSource"       de dónde salió el precio;
--                            "agreementId"       convenio aplicado (FK compuesta);
--                            "agreementName"     su nombre en ese momento;
--                            "pricingLocationId" sede con la que se resolvió.
--                          NULL = «sin convenio» (los ítems existentes: sin
--                          backfill).
--   triggers de bloqueo    un plan firmado (DX-012) o cerrado (DX-109) tampoco
--                          cambia las cinco columnas nuevas.
--
-- Compatible hacia atrás: solo AÑADE columnas NULL, una FK (todas las filas
-- existentes tienen "agreementId" NULL, así que cumple) y un índice del lado
-- hijo; las dos funciones de trigger se reemplazan con las mismas reglas
-- (versión vigente: 20261019194000_sec041_plan_item_catalog_price) más las
-- columnas nuevas. Las columnas nacen NULL en filas existentes, así que los
-- triggers no tienen nada que bloquear hasta que la API las escriba.
--
-- Grants: no aplica (tabla existente).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "treatment_plan_items"
  ADD COLUMN "basePrice" DECIMAL(12,2),
  ADD COLUMN "priceSource" "PriceSource",
  ADD COLUMN "agreementId" UUID,
  ADD COLUMN "agreementName" TEXT,
  ADD COLUMN "pricingLocationId" UUID;

ALTER TABLE "treatment_plan_items" ADD CONSTRAINT "treatment_plan_items_base_price_nonneg"
  CHECK ("basePrice" IS NULL OR "basePrice" >= 0) NOT VALID;
ALTER TABLE "treatment_plan_items" VALIDATE CONSTRAINT "treatment_plan_items_base_price_nonneg";

-- FK COMPUESTA: el convenio aplicado es de la MISMA clínica (SEC-004). Todas las
-- filas existentes tienen "agreementId" NULL.
ALTER TABLE "treatment_plan_items" ADD CONSTRAINT "treatment_plan_items_agreement_fkey"
  FOREIGN KEY ("tenantId", "agreementId") REFERENCES "agreements"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "treatment_plan_items" VALIDATE CONSTRAINT "treatment_plan_items_agreement_fkey";

-- Lado hijo de la FK del convenio.
CREATE INDEX "treatment_plan_items_tenant_agreement_idx"
  ON "treatment_plan_items"("tenantId", "agreementId");

-- ---------------------------------------------------------------------------
-- Bloqueos: versión vigente (20261019194000_sec041_plan_item_catalog_price) más
-- las cinco columnas de la foto del precio.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public."treatment_plan_items_locked_when_accepted"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  plan_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD."planId" ELSE NEW."planId" END;
BEGIN
  PERFORM 1 FROM public."treatment_plans" WHERE "id" = plan_id FOR SHARE;
  IF NOT EXISTS (SELECT 1 FROM public."treatment_plan_acceptances" WHERE "planId" = plan_id) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'el plan está aceptado y firmado: no admite ítems nuevos'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('app.current_tenant', true), '') <> '' THEN
      RAISE EXCEPTION 'el plan está aceptado y firmado: sus ítems no se borran'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."planId" IS DISTINCT FROM OLD."planId"
     OR NEW."toothNumber" IS DISTINCT FROM OLD."toothNumber"
     OR NEW."surfaces" IS DISTINCT FROM OLD."surfaces"
     OR NEW."catalogItemId" IS DISTINCT FROM OLD."catalogItemId"
     OR NEW."catalogPrice" IS DISTINCT FROM OLD."catalogPrice"
     OR NEW."basePrice" IS DISTINCT FROM OLD."basePrice"
     OR NEW."priceSource" IS DISTINCT FROM OLD."priceSource"
     OR NEW."agreementId" IS DISTINCT FROM OLD."agreementId"
     OR NEW."agreementName" IS DISTINCT FROM OLD."agreementName"
     OR NEW."pricingLocationId" IS DISTINCT FROM OLD."pricingLocationId"
     OR NEW."price" IS DISTINCT FROM OLD."price"
     OR NEW."discount" IS DISTINCT FROM OLD."discount"
     OR NEW."discountReason" IS DISTINCT FROM OLD."discountReason"
     OR NEW."discountReasonNote" IS DISTINCT FROM OLD."discountReasonNote"
     OR NEW."discountById" IS DISTINCT FROM OLD."discountById"
     OR NEW."discountAt" IS DISTINCT FROM OLD."discountAt"
     OR NEW."discountLocationId" IS DISTINCT FROM OLD."discountLocationId"
     OR NEW."notes" IS DISTINCT FROM OLD."notes"
     OR NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt"
     OR (NEW."status" = 'PROPOSED' AND OLD."status" <> 'PROPOSED') THEN
    RAISE EXCEPTION 'el plan está aceptado y firmado: sus ítems no se modifican'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public."treatment_plan_items_locked_when_closed"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  plan_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD."planId" ELSE NEW."planId" END;
  plan_status text;
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
    RAISE EXCEPTION 'el plan está cerrado: sus ítems no se añaden, cambian ni retiran'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
