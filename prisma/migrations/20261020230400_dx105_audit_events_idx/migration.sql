-- DX-105: índices parciales de audit_events para AGREEMENT y PRICE_LIST
-- (convenios y listas de precios).
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType".
-- Va en su PROPIA migración: los valores se añadieron en
-- 20261020230000_dx105_enums y Postgres no deja usar un valor de enum nuevo en
-- la misma transacción que lo crea.
--
-- Aditiva; se propaga a cada partición. IF NOT EXISTS: idempotente.

CREATE INDEX IF NOT EXISTS "audit_events_resource_agreement_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'AGREEMENT';

CREATE INDEX IF NOT EXISTS "audit_events_resource_price_list_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'PRICE_LIST';
