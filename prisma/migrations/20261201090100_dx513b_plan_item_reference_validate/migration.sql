-- DX-513-bis: valida los CHECK y la FK que
-- 20261201090000_dx513b_plan_item_reference_snapshot añadió NOT VALID. Las
-- columnas son nuevas y sin relleno: todas las filas existentes las tienen
-- NULL y cumplen.
--
-- VALIDATE CONSTRAINT solo toma SHARE UPDATE EXCLUSIVE sobre
-- `treatment_plan_items` (no bloquea lecturas ni escrituras) y la recorre una
-- vez.
--
-- FK bajo FORCE (DX-134): validar una FK lee la hija con la RLS del owner,
-- así que se quita FORCE a la hija en esta misma transacción y se devuelve al
-- final (`currencies` es un catálogo global sin RLS), como
-- 20261128090200_dx502_plan_item_catalog_currency_fk_validate.
--
-- lock_timeout 5 s; para reintentar, `npx prisma migrate resolve
-- --rolled-back 20261201090100_dx513b_plan_item_reference_validate` y
-- `deploy`. Vuelta atrás: no hace falta (las restricciones siguen NOT VALID
-- si se omite).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "treatment_plan_items" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_items" VALIDATE CONSTRAINT "treatment_plan_items_reference_rate_check";
ALTER TABLE "treatment_plan_items" VALIDATE CONSTRAINT "treatment_plan_items_reference_price_check";
ALTER TABLE "treatment_plan_items" VALIDATE CONSTRAINT "treatment_plan_items_reference_currency_fkey";
ALTER TABLE "treatment_plan_items" FORCE ROW LEVEL SECURITY;
