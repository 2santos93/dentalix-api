-- DX-113: restaura FORCE ROW LEVEL SECURITY en las tablas a las que se lo
-- quitó 20260731115959_dx113_unforce_medical_history_versions
-- para que 20260731120000_structured_clinical_history
-- funcione con un owner sin superusuario ni BYPASSRLS.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "medical_history_versions" FORCE ROW LEVEL SECURITY;
