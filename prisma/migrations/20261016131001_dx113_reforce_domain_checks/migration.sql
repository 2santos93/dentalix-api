-- DX-113: restaura FORCE ROW LEVEL SECURITY en las tablas a las que se lo
-- quitó 20261016125959_dx113_unforce_domain_checks
-- para que 20261016130000_domain_checks y 20261016131000_currency_fks
-- funcione con un owner sin superusuario ni BYPASSRLS.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "dental_catalog_items" FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plans" FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_items" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_plans" FORCE ROW LEVEL SECURITY;
ALTER TABLE "installments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "inventory_items" FORCE ROW LEVEL SECURITY;
ALTER TABLE "inventory_movements" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tooth_records" FORCE ROW LEVEL SECURITY;
