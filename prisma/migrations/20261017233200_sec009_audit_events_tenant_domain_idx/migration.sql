-- SEC-009: índice parcial del tipo de recurso de auditoría TENANT_DOMAIN.
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType"
-- (la igualdad de enums no sirve de condición de índice bajo RLS; el predicado
-- parcial sí). Va en su PROPIA migración: el valor se añadió en
-- 20261017233100_sec009_audit_resource_tenant_domain y Postgres no deja usar
-- un valor de enum nuevo en la misma transacción que lo crea.
--
-- Aditiva; se propaga a cada partición. IF NOT EXISTS: idempotente.

CREATE INDEX IF NOT EXISTS "audit_events_resource_tenant_domain_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'TENANT_DOMAIN';
