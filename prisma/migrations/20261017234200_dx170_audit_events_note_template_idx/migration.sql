-- DX-170: índice parcial de audit_events para CLINICAL_NOTE_TEMPLATE.
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType".
-- Va en su PROPIA migración: el valor se añadió en
-- 20261017234000_dx170_audit_resource_note_template y Postgres no deja usar un
-- valor de enum nuevo en la misma transacción que lo crea.
--
-- Aditiva; se propaga a cada partición. IF NOT EXISTS: idempotente.

CREATE INDEX IF NOT EXISTS "audit_events_resource_clinical_note_template_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'CLINICAL_NOTE_TEMPLATE';
