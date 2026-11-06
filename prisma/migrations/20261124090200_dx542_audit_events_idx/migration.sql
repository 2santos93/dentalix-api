-- DX-542: índices parciales de audit_events para EQUIPMENT y
-- EQUIPMENT_MAINTENANCE.
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType".
-- Va en su PROPIA migración: los valores se añadieron en
-- 20261124090000_dx542_enums y Postgres no deja usar un valor de enum nuevo
-- en la misma transacción que lo crea.
--
-- No es concurrente (tabla particionada): bloquea las escrituras de auditoría
-- mientras se construye. Se despliega a una hora de poco tráfico, como DX-439.
--
-- lock_timeout 5 s: acota la ESPERA del bloqueo. Si falla: `npx prisma migrate
-- resolve --rolled-back 20261124090200_dx542_audit_events_idx` y repetir
-- `migrate deploy`.
--
-- Aditiva; se propaga a cada partición. IF NOT EXISTS: idempotente.
-- Vuelta atrás: DROP INDEX de los dos.

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "audit_events_resource_equipment_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'EQUIPMENT';

CREATE INDEX IF NOT EXISTS "audit_events_resource_equipment_maintenance_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'EQUIPMENT_MAINTENANCE';
