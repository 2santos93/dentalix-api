-- DX-422: valida el CHECK de actor (sin bloquear escrituras, como DX-361).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "audit_events" VALIDATE CONSTRAINT "audit_events_actor_check";
