-- DX-584: VALIDATE del CHECK y la FK añadidos NOT VALID en 20270126140000, en
-- su propia transacción (SHARE UPDATE EXCLUSIVE: no bloquea las escrituras).
-- Columnas nuevas ('{}' y NULL hasta que el ADMIN las configure, siempre con
-- la API validando antes): no hay nada que corregir. Ni `tenants` ni
-- `currencies` tienen RLS: la validación ve todas las filas también con un
-- owner sin superusuario (DX-134/DX-316), sin NO FORCE.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_accepted_currencies_check";
ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_rate_reference_currency_fkey";
