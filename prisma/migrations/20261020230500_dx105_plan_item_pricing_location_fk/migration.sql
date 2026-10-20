-- DX-105: FK compuesta de la sede con la que se resolvió el precio del ítem.
--
-- "pricingLocationId" (migración 20261020230300) nació sin FK. Se alinea con
-- "discountLocationId" (DX-204): la sede es de la MISMA clínica (SEC-004).
--
-- Compatible hacia atrás: todas las filas existentes tienen la columna NULL
-- (nadie la escribe aún), así que la FK se cumple; se añade NOT VALID y se
-- valida aparte para no mantener el bloqueo largo. Incluye el índice del lado
-- hijo.
--
-- Grants: no aplica (tabla existente).

SET LOCAL lock_timeout = '5s';

-- DX-134: con un owner sin BYPASSRLS, ADD/VALIDATE de una FK entre tablas con
-- RLS FORCE falla o acepta huérfanas; se quita FORCE de la hija y de la
-- referenciada durante la FK y se repone después (misma transacción).
ALTER TABLE "treatment_plan_items" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "locations" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "treatment_plan_items" ADD CONSTRAINT "treatment_plan_items_pricing_location_fkey"
  FOREIGN KEY ("tenantId", "pricingLocationId") REFERENCES "locations"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "treatment_plan_items" VALIDATE CONSTRAINT "treatment_plan_items_pricing_location_fkey";

ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_items" FORCE ROW LEVEL SECURITY;

CREATE INDEX "treatment_plan_items_tenant_pricing_location_idx"
  ON "treatment_plan_items"("tenantId", "pricingLocationId");
