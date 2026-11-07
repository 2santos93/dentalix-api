-- DX-502-bis: valida la FK de tenants."catalogCurrency" a currencies, añadida
-- NOT VALID en 20261129090000. Toda fila vale NULL al llegar aquí (o una
-- moneda que la API ya validó contra currencies). Ni `tenants` ni
-- `currencies` tienen RLS: la validación ve todas las filas también con un
-- owner sin superusuario (DX-134/DX-316), sin NO FORCE.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_catalog_currency_fkey";
