-- DX-439: índice parcial de audit_events para CLOSING_QUEUE_DISMISSAL.
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType".
-- Va en su PROPIA migración: el valor se añadió en 20261108100000_dx439_enums
-- y Postgres no deja usar un valor de enum nuevo en la misma transacción que
-- lo crea.
--
-- No es concurrente (tabla particionada): bloquea las escrituras de auditoría
-- mientras se construye. Se despliega a una hora de poco tráfico, como DX-253.
--
-- lock_timeout 5 s: acota la ESPERA del bloqueo. Si falla: `npx prisma migrate
-- resolve --rolled-back 20261108100001_dx439_audit_events_idx` y repetir
-- `migrate deploy`.
--
-- Aditiva; se propaga a cada partición. IF NOT EXISTS: idempotente.

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "audit_events_resource_closing_queue_dismissal_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'CLOSING_QUEUE_DISMISSAL';
