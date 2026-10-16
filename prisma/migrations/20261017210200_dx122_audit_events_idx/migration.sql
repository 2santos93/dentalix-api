-- DX-122: índices parciales de audit_events para SCHEDULE_BLOCK y
-- WAITLIST_ENTRY.
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType".
-- Va en su PROPIA migración: los valores se añadieron en
-- 20261017210000_dx122_audit_resources y Postgres no deja usar un valor de enum
-- nuevo en la misma transacción que lo crea.
--
-- Aditiva; se propaga a cada partición. IF NOT EXISTS: idempotente.

CREATE INDEX IF NOT EXISTS "audit_events_resource_schedule_block_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'SCHEDULE_BLOCK';

CREATE INDEX IF NOT EXISTS "audit_events_resource_waitlist_entry_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'WAITLIST_ENTRY';
