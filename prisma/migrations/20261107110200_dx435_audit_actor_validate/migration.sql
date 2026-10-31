-- DX-435: VALIDATE del CHECK de actor de audit_events que cambió
-- 20261107110100 (NOT VALID). Va en su propia transacción: SHARE UPDATE
-- EXCLUSIVE lee la tabla sin bloquear la escritura de auditoría (molde de
-- DX-361 / DX-390).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "audit_events" VALIDATE CONSTRAINT "audit_events_actor_check";
