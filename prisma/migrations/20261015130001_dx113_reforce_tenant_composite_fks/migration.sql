-- DX-113: restaura FORCE ROW LEVEL SECURITY en las tablas a las que se lo
-- quitó 20261015125959_dx113_unforce_tenant_composite_fks
-- para que 20261015130000_tenant_composite_fks
-- funcione con un owner sin superusuario ni BYPASSRLS.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "patients" FORCE ROW LEVEL SECURITY;
ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plans" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_plans" FORCE ROW LEVEL SECURITY;
ALTER TABLE "inventory_items" FORCE ROW LEVEL SECURITY;
ALTER TABLE "location_schedules" FORCE ROW LEVEL SECURITY;
ALTER TABLE "medical_history_versions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "clinical_entries" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tooth_records" FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_items" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "installments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "inventory_movements" FORCE ROW LEVEL SECURITY;
ALTER TABLE "location_schedule_ranges" FORCE ROW LEVEL SECURITY;
