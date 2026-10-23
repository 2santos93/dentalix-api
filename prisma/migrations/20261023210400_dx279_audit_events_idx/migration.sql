-- DX-279: índice parcial de audit_events para CANCELLATION_POLICY (nueva
-- versión de la política de cancelación de una sede).
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType".
-- Va en su PROPIA migración, después de 20261023210000_dx279_enums, que añadió
-- el valor.
--
-- Aditiva; se propaga a cada partición. IF NOT EXISTS: idempotente.

CREATE INDEX IF NOT EXISTS "audit_events_resource_cancellation_policy_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'CANCELLATION_POLICY';
