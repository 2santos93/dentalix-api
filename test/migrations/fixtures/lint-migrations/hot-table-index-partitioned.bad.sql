-- Índice recursivo sobre el padre: bloquea los INSERT de toda la auditoría.
SET LOCAL lock_timeout = '5s';
CREATE INDEX IF NOT EXISTS "audit_events_resource_x_idx"
  ON "audit_events" ("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'X';
