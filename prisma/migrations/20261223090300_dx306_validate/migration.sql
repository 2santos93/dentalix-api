-- DX-306: VALIDATE del CHECK de los días máximos de reposo de la clínica
-- (añadido NOT VALID en 20261223090200). Va aparte para no sostener el
-- candado de la tabla tenants mientras se recorre: VALIDATE solo toma SHARE
-- UPDATE EXCLUSIVE (no bloquea lecturas ni escrituras). Todas las filas
-- tienen el DEFAULT 30: no puede fallar.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_certificate_rest_max_days_check";
