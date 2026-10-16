-- DX-113: restaura FORCE ROW LEVEL SECURITY en las tablas a las que se lo
-- quitó 20261016155959_dx113_unforce_payments_void
-- para que 20261016160000_payment_void_audit
-- funcione con un owner sin superusuario ni BYPASSRLS.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;
