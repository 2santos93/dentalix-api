-- DX-066: valida el CHECK que 20270208140000 añadió NOT VALID. Su propia
-- transacción: VALIDATE recorre la tabla con SHARE UPDATE EXCLUSIVE, que deja
-- leer y escribir (molde de DX-285). Todas las filas cumplen: nacen con el
-- DEFAULT 4 / 6. tenants no tiene RLS.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_perio_pd_thresholds_check";
