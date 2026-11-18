-- DX-561: VALIDATE de los CHECK que 20270107140100 y 20270107140200 dejaron
-- NOT VALID. Van en su propia transacción: SHARE UPDATE EXCLUSIVE lee la
-- tabla sin bloquear las escrituras (molde de DX-290 / DX-572).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "treatment_plans"
  VALIDATE CONSTRAINT "treatment_plans_quote_follow_up_pause_check";
ALTER TABLE "signature_requests"
  VALIDATE CONSTRAINT "signature_requests_origin_check";
ALTER TABLE "signature_requests"
  VALIDATE CONSTRAINT "signature_requests_state_check";
ALTER TABLE "signature_requests"
  VALIDATE CONSTRAINT "signature_requests_revoked_check";
ALTER TABLE "audit_events" VALIDATE CONSTRAINT "audit_events_actor_check";
