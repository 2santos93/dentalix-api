-- DX-502: valida la FK treatment_plan_items_catalog_currency_fkey que
-- 20261111180000_dx502_plan_item_catalog_currency añadió NOT VALID, después
-- del relleno (20261111180100): todas las monedas rellenadas vienen de
-- "locations"."currency", que ya tiene su FK a currencies.
--
-- VALIDATE CONSTRAINT solo toma SHARE UPDATE EXCLUSIVE sobre
-- `treatment_plan_items` (no bloquea lecturas ni escrituras) y la recorre una
-- vez.
--
-- FK bajo FORCE (DX-134): validar una FK lee la hija con la RLS del owner,
-- así que se quita FORCE a la hija en esta misma transacción y se devuelve al
-- final (`currencies` es un catálogo global sin RLS).
--
-- Vuelta atrás: no hace falta (la FK sigue existiendo NOT VALID si se omite).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "treatment_plan_items" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_items" VALIDATE CONSTRAINT "treatment_plan_items_catalog_currency_fkey";
ALTER TABLE "treatment_plan_items" FORCE ROW LEVEL SECURITY;
