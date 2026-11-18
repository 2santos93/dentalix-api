-- DX-556: VALIDATE de los CHECK añadidos NOT VALID en 20270114090200
-- (tenants."leadLostRetentionMonths": todas las filas tienen el DEFAULT 12) y
-- 20270114090300 (el de actor de audit_events). Va en su propia transacción:
-- SHARE UPDATE EXCLUSIVE lee la tabla sin bloquear las escrituras (molde de
-- DX-285 / DX-101).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants" VALIDATE CONSTRAINT "tenants_lead_lost_retention_months_check";
ALTER TABLE "audit_events" VALIDATE CONSTRAINT "audit_events_actor_check";
