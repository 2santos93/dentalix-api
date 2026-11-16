-- DX-290: VALIDATE de los CHECK que 20261228120000 y 20261228120100 dejaron
-- NOT VALID. Van en su propia transacción: SHARE UPDATE EXCLUSIVE lee la
-- tabla sin bloquear las escrituras (molde de DX-361 / DX-569).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "medical_history_submissions"
  VALIDATE CONSTRAINT "medical_history_submissions_origin_creator_check";
ALTER TABLE "audit_events" VALIDATE CONSTRAINT "audit_events_actor_check";
