-- DX-101-bis: VALIDATE del CHECK de actor de audit_events que cambió
-- 20270115140200 (NOT VALID). Va en su propia transacción: SHARE UPDATE
-- EXCLUSIVE lee la tabla sin bloquear la escritura de auditoría (molde de
-- DX-101 / DX-306 / DX-569).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "audit_events" VALIDATE CONSTRAINT "audit_events_actor_check";
