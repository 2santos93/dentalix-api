-- DX-265: VALIDATE de los CHECK que 20270202090000 añadió NOT VALID: el
-- de actor de audit_events y el del origen de la llegada de appointments.
-- Su propia transacción: SHARE UPDATE EXCLUSIVE lee la tabla sin bloquear las
-- escrituras (molde de DX-101 / DX-306 / DX-569 / DX-101-bis).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "audit_events" VALIDATE CONSTRAINT "audit_events_actor_check";
ALTER TABLE "appointments" VALIDATE CONSTRAINT "appointments_arrival_source_check";
