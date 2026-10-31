-- DX-361: valida el CHECK audit_events_actor_check que 20261107100000 añadió
-- NOT VALID. VALIDATE de un CHECK toma SHARE UPDATE EXCLUSIVE: recorre
-- audit_events y sus particiones sin bloquear la escritura de auditoría. El
-- CHECK nuevo es más permisivo que el anterior, así que toda fila existente
-- cumple.
--
-- lock_timeout 5 s; para reintentar, `prisma migrate resolve --rolled-back
-- 20261107100100_dx361_audit_actor_validate` y `deploy`.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "audit_events" VALIDATE CONSTRAINT "audit_events_actor_check";
