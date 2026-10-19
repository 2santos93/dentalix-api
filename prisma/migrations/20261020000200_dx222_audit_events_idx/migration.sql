-- DX-222: índices parciales de audit_events para POSTOP_TEMPLATE y
-- POSTOP_DELIVERY (plantillas de indicaciones postoperatorias y su entrega).
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType".
-- Va en su PROPIA migración: los valores se añadieron en
-- 20261020000000_dx222_enums y Postgres no deja usar un valor de enum nuevo en
-- la misma transacción que lo crea.
--
-- Aditiva; se propaga a cada partición. IF NOT EXISTS: idempotente.

CREATE INDEX IF NOT EXISTS "audit_events_resource_postop_template_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'POSTOP_TEMPLATE';

CREATE INDEX IF NOT EXISTS "audit_events_resource_postop_delivery_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'POSTOP_DELIVERY';
