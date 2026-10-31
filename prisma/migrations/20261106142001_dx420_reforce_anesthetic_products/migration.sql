-- DX-420: restaura FORCE ROW LEVEL SECURITY en "anesthetic_products", que
-- quitó 20261106141959_dx420_unforce_anesthetic_products para que
-- 20261106142000_dx420_anesthesia_pediatric_epinephrine funcione con un
-- owner sin superusuario ni BYPASSRLS.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "anesthetic_products" FORCE ROW LEVEL SECURITY;
