-- DX-212: índices parciales de audit_events para DENTAL_CATALOG_ITEM y
-- LOCATION (cambios de CUPS y de REPS).
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType".
-- Va en su PROPIA migración: los valores se añadieron en
-- 20261018140000_dx212_audit_resources y Postgres no deja usar un valor de
-- enum nuevo en la misma transacción que lo crea.
--
-- Aditiva; se propaga a cada partición. IF NOT EXISTS: idempotente.

CREATE INDEX IF NOT EXISTS "audit_events_resource_dental_catalog_item_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'DENTAL_CATALOG_ITEM';

CREATE INDEX IF NOT EXISTS "audit_events_resource_location_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'LOCATION';
