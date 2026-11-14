-- DX-569: índices parciales de audit_events para PAYMENT_LINK y
-- PAYMENT_REPORT.
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType".
-- Van en su PROPIA migración: los valores se añadieron en
-- 20261220090000_dx569_enums y Postgres no deja usar un valor de enum nuevo
-- en la misma transacción que lo crea.
--
-- No es concurrente (tabla particionada): bloquea las escrituras de auditoría
-- mientras se construye. Se despliega a una hora de poco tráfico, como DX-439.
--
-- lock_timeout 5 s: acota la ESPERA del bloqueo. Si falla: `npx prisma migrate
-- resolve --rolled-back 20261220090100_dx569_audit_events_idx` y repetir
-- `migrate deploy`.
--
-- Aditiva; se propaga a cada partición. IF NOT EXISTS: idempotente.
-- Vuelta atrás: DROP INDEX "audit_events_resource_payment_link_idx",
-- "audit_events_resource_payment_report_idx".

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "audit_events_resource_payment_link_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'PAYMENT_LINK';

CREATE INDEX IF NOT EXISTS "audit_events_resource_payment_report_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'PAYMENT_REPORT';
