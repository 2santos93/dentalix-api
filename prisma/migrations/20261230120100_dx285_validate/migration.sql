-- DX-285: valida los CHECK añadidos NOT VALID en 20261230120000
-- (molde de DX-190: el VALIDATE en su propia transacción recorre la tabla con
-- SHARE UPDATE EXCLUSIVE, que deja leer y escribir). Todas las filas cumplen:
-- tenants tiene el DEFAULT 30 y ningún caso anterior tiene honorario.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_ortho_overdue_days_check";
ALTER TABLE "ortho_cases" VALIDATE CONSTRAINT "ortho_cases_fee_check";
ALTER TABLE "ortho_cases" VALIDATE CONSTRAINT "ortho_cases_fee_actor_check";
