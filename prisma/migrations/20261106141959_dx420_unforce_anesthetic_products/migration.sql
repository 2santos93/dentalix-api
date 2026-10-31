-- DX-420: quita FORCE ROW LEVEL SECURITY a "anesthetic_products" para que
-- 20261106142000_dx420_anesthesia_pediatric_epinephrine rellene los valores
-- por defecto de TODAS las clínicas con un owner sin superusuario ni
-- BYPASSRLS (DX-113: con FORCE el UPDATE vería 0 filas). Lo restaura
-- 20261106142001_dx420_reforce_anesthetic_products; si la del medio falla,
-- lo vigila test/rls-catalog.int-spec.ts. Ver README, «Despliegue: roles de la BD».
SET LOCAL lock_timeout = '5s';

ALTER TABLE "anesthetic_products" NO FORCE ROW LEVEL SECURITY;
