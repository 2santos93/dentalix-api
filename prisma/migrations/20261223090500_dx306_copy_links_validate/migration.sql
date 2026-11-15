-- DX-306: VALIDATE del CHECK de actor de audit_events que 20261223090400 dejó
-- NOT VALID (la apertura y la descarga públicas de la copia del certificado).
-- Va en su propia transacción: SHARE UPDATE EXCLUSIVE lee la tabla sin
-- bloquear la escritura (molde de DX-361 / DX-443 / DX-467 / DX-468).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "audit_events" VALIDATE CONSTRAINT "audit_events_actor_check";
