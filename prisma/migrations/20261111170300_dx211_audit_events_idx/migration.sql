-- DX-211: índice parcial de audit_events para CHAIR.
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType".
-- Va en su PROPIA migración: el valor se añadió en 20261111170000_dx211_enums
-- y Postgres no deja usar un valor de enum nuevo en la misma transacción que
-- lo crea.
--
-- Aditiva; se propaga a cada partición. IF NOT EXISTS: idempotente.
-- Vuelta atrás: DROP INDEX "audit_events_resource_chair_idx".

CREATE INDEX IF NOT EXISTS "audit_events_resource_chair_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'CHAIR';
