-- DX-316: índice parcial de audit_events para LOCATION_CALENDAR (cambios del
-- calendario de una sede: días hábiles, festivos e importaciones).
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType".
-- Va en su PROPIA migración: el valor se añadió en 20261028170000_dx316_enums
-- y Postgres no deja usar un valor de enum nuevo en la misma transacción que
-- lo crea.
--
-- No es concurrente (tabla particionada): bloquea las escrituras de auditoría
-- mientras se construye. Se despliega a una hora de poco tráfico, como DX-233,
-- DX-051 y DX-328.
--
-- lock_timeout 5 s: acota la ESPERA del bloqueo (no la construcción). Una
-- transacción larga que escribe auditoría no deja las escrituras nuevas en
-- cola sin límite detrás de este CREATE INDEX; si falla, se reintenta el
-- deploy.
--
-- Aditiva; se propaga a cada partición. IF NOT EXISTS: idempotente.

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "audit_events_resource_location_calendar_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'LOCATION_CALENDAR';
