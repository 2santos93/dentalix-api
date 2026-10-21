-- DX-105: el catálogo marca si un procedimiento admite descuento y expone el
-- destino de las FK compuestas de las listas de precios.
--
-- Cambios:
--   dental_catalog_items   columna "allowDiscount" BOOLEAN NOT NULL DEFAULT true
--                          (ADD COLUMN con default constante: sin reescritura de
--                          tabla). Un ítem con false no recibe convenio ni
--                          descuento porcentual.
--                          UNIQUE ("tenantId","id"): destino de la FK compuesta
--                          de price_list_items (SEC-004).
--
-- Compatible hacia atrás: el código anterior no conoce la columna y el default
-- conserva el comportamiento actual; el índice único es sobre una clave que ya
-- es única (id), así que no puede fallar por datos.
--
-- Grants: no aplica (tabla existente).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "dental_catalog_items" ADD COLUMN "allowDiscount" BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX "dental_catalog_items_tenant_id_key"
  ON "dental_catalog_items"("tenantId", "id");
