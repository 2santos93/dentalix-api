-- DX-050: producción atribuible. Quién realizó cada ítem del plan, dónde y cuándo.
--
-- Cambios:
--   treatment_plan_items   columnas NULL:
--                            "performedById"           usuario que lo realizó
--                                                      (como appointments."providerId");
--                            "performedByMembershipId" su membresía en ESTA clínica;
--                            "performedLocationId"     sede donde se realizó;
--                            "completedAt"             cuándo (hora del servidor).
--                          NULL en los DONE que ya existían: «Sin atribuir»
--                          (sin backfill: no se inventa quién los hizo).
--   clinic_memberships     UNIQUE ("tenantId","id","userId"): destino de la FK
--                          compuesta de quien lo realizó.
--   trigger de plan cerrado  admite además corregir la atribución de un ítem
--                          DONE (y nada más) en un plan cerrado.
--
-- Reglas en la BD (la API responde antes en español; esto es la red):
--   - FK COMPUESTA ("tenantId","performedByMembershipId","performedById") ->
--     clinic_memberships("tenantId","id","userId"): quien lo realizó es miembro
--     de la MISMA clínica y la membresía es la de ese usuario (SEC-004);
--   - FK COMPUESTA ("tenantId","performedLocationId") -> locations: la sede es
--     de la MISMA clínica;
--   - usuario y membresía van juntos (con uno solo la FK no se comprobaría);
--   - un ítem que no está DONE no tiene atribución (salir de DONE la limpia).
--
-- Compatible hacia atrás: solo AÑADE columnas NULL, un índice único sobre una
-- clave que ya es única (id), dos FK y dos CHECK que todas las filas existentes
-- cumplen (las columnas nacen NULL), sus índices del lado hijo, y una rama más
-- en el trigger de plan cerrado (lo que antes se admitía se sigue admitiendo).
-- FK y CHECK se añaden NOT VALID y se validan aparte.
--
-- Grants: no aplica (tablas existentes).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "treatment_plan_items"
  ADD COLUMN "performedById" UUID,
  ADD COLUMN "performedByMembershipId" UUID,
  ADD COLUMN "performedLocationId" UUID,
  ADD COLUMN "completedAt" TIMESTAMP(3);

ALTER TABLE "treatment_plan_items" ADD CONSTRAINT "treatment_plan_items_performed_by_pair"
  CHECK (("performedById" IS NULL) = ("performedByMembershipId" IS NULL)) NOT VALID;
ALTER TABLE "treatment_plan_items" VALIDATE CONSTRAINT "treatment_plan_items_performed_by_pair";

ALTER TABLE "treatment_plan_items" ADD CONSTRAINT "treatment_plan_items_attribution_only_done"
  CHECK (
    "status" = 'DONE'
    OR ("performedById" IS NULL AND "performedByMembershipId" IS NULL
        AND "performedLocationId" IS NULL AND "completedAt" IS NULL)
  ) NOT VALID;
ALTER TABLE "treatment_plan_items" VALIDATE CONSTRAINT "treatment_plan_items_attribution_only_done";

-- Destino de la FK compuesta (la clave es única de por sí por id: no puede
-- fallar por datos).
CREATE UNIQUE INDEX "clinic_memberships_tenant_id_user_key"
  ON "clinic_memberships"("tenantId", "id", "userId");

-- DX-134: con un owner sin BYPASSRLS, ADD/VALIDATE de una FK entre tablas con
-- RLS FORCE falla o acepta huérfanas; se quita FORCE de la hija y de las
-- referenciadas durante las FK y se repone después (misma transacción).
ALTER TABLE "treatment_plan_items" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "clinic_memberships" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "locations" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "treatment_plan_items" ADD CONSTRAINT "treatment_plan_items_performed_by_fkey"
  FOREIGN KEY ("tenantId", "performedByMembershipId", "performedById")
  REFERENCES "clinic_memberships"("tenantId", "id", "userId")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "treatment_plan_items" VALIDATE CONSTRAINT "treatment_plan_items_performed_by_fkey";

ALTER TABLE "treatment_plan_items" ADD CONSTRAINT "treatment_plan_items_performed_location_fkey"
  FOREIGN KEY ("tenantId", "performedLocationId") REFERENCES "locations"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "treatment_plan_items" VALIDATE CONSTRAINT "treatment_plan_items_performed_location_fkey";

ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "clinic_memberships" FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_items" FORCE ROW LEVEL SECURITY;

-- Lados hijos de las dos FK.
CREATE INDEX "treatment_plan_items_tenant_performed_by_idx"
  ON "treatment_plan_items"("tenantId", "performedByMembershipId", "performedById");
CREATE INDEX "treatment_plan_items_tenant_performed_location_idx"
  ON "treatment_plan_items"("tenantId", "performedLocationId");

-- ---------------------------------------------------------------------------
-- Plan cerrado: versión vigente (20261020230300_dx105_plan_item_pricing_snapshot)
-- más la corrección de la atribución de un ítem DONE. En esa rama solo pueden
-- cambiar las cuatro columnas de la atribución (y "updatedAt"): se compara la
-- fila entera sin ellas, así una columna futura queda congelada por defecto.
-- ---------------------------------------------------------------------------
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
