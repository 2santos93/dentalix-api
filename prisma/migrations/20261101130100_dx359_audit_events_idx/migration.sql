-- DX-359: índices parciales de audit_events para PASSWORD_CHANGE,
-- STAFF_INVITATION y CLINIC.
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_action_<valor>_idx" por cada valor de "AuditAction" y
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType".
-- Va en su PROPIA migración: los valores se añadieron en
-- 20261101130000_dx359_enums y Postgres no deja usar un valor de enum nuevo
-- en la misma transacción que lo crea.
--
-- No es concurrente (tabla particionada): bloquea las escrituras de auditoría
-- mientras se construye. Se despliega a una hora de poco tráfico, como DX-316,
-- DX-328 y DX-051.
--
-- lock_timeout 5 s: acota la ESPERA del bloqueo (no la construcción). Una
-- transacción larga que escribe auditoría no deja las escrituras nuevas en
-- cola sin límite detrás de este CREATE INDEX. Si falla, Prisma la deja
-- marcada como fallida y otro `migrate deploy` se para con P3009: antes hay
-- que ejecutar `npx prisma migrate resolve --rolled-back
-- 20261101130100_dx359_audit_events_idx` y luego repetir `migrate deploy`.
--
-- Aditiva; se propaga a cada partición. IF NOT EXISTS: idempotente.

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "audit_events_action_password_change_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "action" = 'PASSWORD_CHANGE';

CREATE INDEX IF NOT EXISTS "audit_events_resource_staff_invitation_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'STAFF_INVITATION';

CREATE INDEX IF NOT EXISTS "audit_events_resource_clinic_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'CLINIC';
