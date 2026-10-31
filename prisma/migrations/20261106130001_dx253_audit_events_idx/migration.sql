-- DX-253: índice parcial de audit_events para PATIENT_CREDIT.
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType".
-- Va en su PROPIA migración: el valor se añadió en 20261106130000_dx253_enums
-- y Postgres no deja usar un valor de enum nuevo en la misma transacción que
-- lo crea.
--
-- No es concurrente (tabla particionada): bloquea las escrituras de auditoría
-- mientras se construye. Se despliega a una hora de poco tráfico, como DX-407.
--
-- lock_timeout 5 s: acota la ESPERA del bloqueo. Si falla: `npx prisma migrate
-- resolve --rolled-back 20261106130001_dx253_audit_events_idx` y repetir
-- `migrate deploy`.
--
-- Aditiva; se propaga a cada partición. IF NOT EXISTS: idempotente.

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "audit_events_resource_patient_credit_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'PATIENT_CREDIT';
