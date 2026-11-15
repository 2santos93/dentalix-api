-- audit_events (particionada): índice de cada partición, la del mes en curso
-- la última, y ON ONLY + ATTACH en el padre al final.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  EXECUTE 'CREATE INDEX IF NOT EXISTS x ON audit_events_p202611 ("tenantId")';
END $$;
CREATE INDEX IF NOT EXISTS "audit_events_resource_x_idx"
  ON ONLY "audit_events" ("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'X';
