-- DX-091: valida el CHECK añadido NOT VALID en 20261231090000 (molde de
-- DX-285: el VALIDATE en su propia transacción recorre la tabla con SHARE
-- UPDATE EXCLUSIVE, que deja leer y escribir). Todas las filas cumplen: la
-- columna nace NULL.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_financial_lock_days_check";
