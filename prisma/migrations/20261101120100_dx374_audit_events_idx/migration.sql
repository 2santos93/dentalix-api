-- DX-374: índice parcial de audit_events para EXCHANGE_RATE (tasas de cambio
-- manuales de la clínica).
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType".
-- Va en su PROPIA migración: el valor se añadió en 20261101120000_dx374_enums
-- y Postgres no deja usar un valor de enum nuevo en la misma transacción que
-- lo crea.
--
-- No es concurrente (tabla particionada): bloquea las escrituras de auditoría
-- mientras se construye. Se despliega a una hora de poco tráfico, como DX-316
-- y DX-328.
--
-- lock_timeout 5 s: acota la ESPERA del bloqueo (no la construcción). Si
-- falla, Prisma la deja marcada como fallida y otro `migrate deploy` se para
-- con P3009: antes hay que ejecutar `npx prisma migrate resolve --rolled-back
-- 20261101120100_dx374_audit_events_idx` y luego repetir `migrate deploy`.
--
-- Aditiva; se propaga a cada partición. IF NOT EXISTS: idempotente.

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "audit_events_resource_exchange_rate_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'EXCHANGE_RATE';
