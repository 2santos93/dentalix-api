-- DX-190: valida el CHECK de los calibres de arco de la clínica, añadido NOT
-- VALID en 20261229190200 (molde de DX-540: el VALIDATE en su propia
-- transacción recorre tenants con SHARE UPDATE EXCLUSIVE, que deja leer y
-- escribir). Todas las filas tienen el DEFAULT de 10 calibres.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_ortho_wire_gauges_check";
