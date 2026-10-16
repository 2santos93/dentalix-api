-- DX-113: restaura FORCE ROW LEVEL SECURITY en las tablas a las que se lo
-- quitó 20261017165959_dx113_unforce_retention
-- para que 20261017170000_dx039_clinical_record_retention
-- funcione con un owner sin superusuario ni BYPASSRLS.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "patients" FORCE ROW LEVEL SECURITY;
ALTER TABLE "clinical_entries" FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;
