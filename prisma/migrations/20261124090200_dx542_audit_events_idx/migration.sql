-- DX-542: índices parciales de audit_events para EQUIPMENT y
-- EQUIPMENT_MAINTENANCE.
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType".
-- Va en su PROPIA migración: los valores se añadieron en
-- 20261124090000_dx542_enums y Postgres no deja usar un valor de enum nuevo
-- en la misma transacción que lo crea.
--
-- Aditiva; se propaga a cada partición. IF NOT EXISTS: idempotente.
-- Vuelta atrás: DROP INDEX de los dos.

CREATE INDEX IF NOT EXISTS "audit_events_resource_equipment_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'EQUIPMENT';

CREATE INDEX IF NOT EXISTS "audit_events_resource_equipment_maintenance_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'EQUIPMENT_MAINTENANCE';
