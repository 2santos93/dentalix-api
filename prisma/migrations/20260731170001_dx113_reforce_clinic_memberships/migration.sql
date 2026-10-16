-- DX-113: restaura FORCE ROW LEVEL SECURITY en las tablas a las que se lo
-- quitó 20260731165959_dx113_unforce_clinic_memberships
-- para que 20260731170000_remove_owner_role
-- funcione con un owner sin superusuario ni BYPASSRLS.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "clinic_memberships" FORCE ROW LEVEL SECURITY;
