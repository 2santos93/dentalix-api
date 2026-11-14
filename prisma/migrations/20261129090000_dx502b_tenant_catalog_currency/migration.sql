-- DX-502-bis: moneda del catálogo explícita por clínica.
--
-- DX-502 congela en cada ítem del plan la moneda del catálogo
-- (`treatment_plan_items."catalogCurrency"`), deducida como la común de las
-- sedes activas. Una clínica con sedes en varias monedas no tiene una común y
-- sus ítems quedan sin ella: el presupuesto oculta el precio de lista y el
-- «Ahorro por convenio». Con esta columna la clínica la dice.
--
--   tenants."catalogCurrency"  CHAR(3) NULL: la moneda en la que está el
--                              catálogo de precios (ISO 4217, FK a
--                              currencies). Si está, es la que se congela en
--                              los ítems NUEVOS; NULL = la regla de DX-502
--                              (la común de las sedes activas, o ninguna).
--                              La cambia el ADMIN (PATCH /clinic/settings,
--                              auditado).
--
-- Los ítems ya creados no cambian (su moneda sigue congelada por el trigger
-- de DX-502) y ningún importe se toca: no hay relleno.
--
-- Expand puro: columna NULL sin DEFAULT (solo catálogo, no reescribe la
-- tabla), que el código anterior no lee ni escribe; una réplica anterior que
-- inserta sin nombrarla deja NULL, que es «sin fijar». La FK va NOT VALID (no
-- recorre filas) y la valida 20261129090100. `tenants` y `currencies` no
-- tienen RLS (patrón DX-316: nada que quitar ni devolver con FORCE, y un
-- owner sin superusuario la aplica igual); la columna hereda el grant de la
-- tabla a dentalix_app.
--
-- Vuelta atrás (sin pérdida de importes): ALTER TABLE "tenants" DROP COLUMN
-- "catalogCurrency"; (la FK cae con ella).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants" ADD COLUMN "catalogCurrency" CHAR(3);

ALTER TABLE "tenants" ADD CONSTRAINT "tenants_catalog_currency_fkey"
  FOREIGN KEY ("catalogCurrency") REFERENCES "currencies"("code")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
