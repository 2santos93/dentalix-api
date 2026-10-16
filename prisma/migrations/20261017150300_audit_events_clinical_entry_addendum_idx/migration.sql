-- DX-038: índice parcial del tipo de recurso de auditoría CLINICAL_ENTRY_ADDENDUM.
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType"
-- (la igualdad de enums no sirve de condición de índice bajo RLS; el predicado
-- parcial sí). Va en su PROPIA migración: el valor se añadió en
-- 20261017150000_audit_resource_clinical_entry_addendum y Postgres no deja usar
-- un valor de enum nuevo en la misma transacción que lo crea.
--
-- Aditiva; se propaga a cada partición. IF NOT EXISTS: idempotente.

CREATE INDEX IF NOT EXISTS "audit_events_resource_clinical_entry_addendum_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'CLINICAL_ENTRY_ADDENDUM';
