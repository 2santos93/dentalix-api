-- DX-136: índices parciales de audit_events para el recurso PAYMENT_RECEIPT y
-- la acción SEND.
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType" y
-- "audit_events_action_<valor>_idx" por cada valor nuevo de "AuditAction". Va
-- en su PROPIA migración: los valores se añadieron en
-- 20261018090000_dx136_receipt_enums y Postgres no deja usar un valor de enum
-- nuevo en la misma transacción que lo crea.
--
-- Aditiva; se propaga a cada partición. IF NOT EXISTS: idempotente.

CREATE INDEX IF NOT EXISTS "audit_events_resource_payment_receipt_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'PAYMENT_RECEIPT';

CREATE INDEX IF NOT EXISTS "audit_events_action_send_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "action" = 'SEND';
