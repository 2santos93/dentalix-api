-- DX-360: índices parciales de audit_events para los recursos de
-- configuración nuevos (LOCATION_SCHEDULE, REMINDER_SETTINGS, PRIVACY_POLICY,
-- APPOINTMENT_TYPE, PAYER, CONSENT_TEMPLATE, PRESCRIPTION_TEMPLATE,
-- INVENTORY_ITEM e INVENTORY_MOVEMENT).
--
-- DX-102 (audit_events particionada) exige un índice parcial
-- "audit_events_resource_<valor>_idx" por cada valor de "AuditResourceType":
-- es el que sirve el filtro por tipo de recurso del registro de auditoría
-- bajo RLS. Va en su PROPIA migración: los valores se añadieron en
-- 20261111110000_dx360_enums y Postgres no deja usar un valor de enum nuevo
-- en la misma transacción que lo crea.
--
-- No es concurrente (tabla particionada): bloquea las escrituras de auditoría
-- mientras se construye. Se despliega a una hora de poco tráfico, como DX-359
-- y DX-439.
--
-- lock_timeout 5 s: acota la ESPERA del bloqueo (no la construcción). Si
-- falla, Prisma la deja marcada como fallida y otro `migrate deploy` se para
-- con P3009: antes hay que ejecutar `npx prisma migrate resolve --rolled-back
-- 20261111110100_dx360_audit_events_idx` y luego repetir `migrate deploy`.
--
-- Aditiva; se propaga a cada partición. IF NOT EXISTS: idempotente.
-- Rollback: DROP INDEX IF EXISTS de cada uno (el filtro sigue funcionando,
-- más lento).

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "audit_events_resource_location_schedule_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'LOCATION_SCHEDULE';

CREATE INDEX IF NOT EXISTS "audit_events_resource_reminder_settings_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'REMINDER_SETTINGS';

CREATE INDEX IF NOT EXISTS "audit_events_resource_privacy_policy_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'PRIVACY_POLICY';

CREATE INDEX IF NOT EXISTS "audit_events_resource_appointment_type_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'APPOINTMENT_TYPE';

CREATE INDEX IF NOT EXISTS "audit_events_resource_payer_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'PAYER';

CREATE INDEX IF NOT EXISTS "audit_events_resource_consent_template_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'CONSENT_TEMPLATE';

CREATE INDEX IF NOT EXISTS "audit_events_resource_prescription_template_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'PRESCRIPTION_TEMPLATE';

CREATE INDEX IF NOT EXISTS "audit_events_resource_inventory_item_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'INVENTORY_ITEM';

CREATE INDEX IF NOT EXISTS "audit_events_resource_inventory_movement_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC)
  WHERE "resourceType" = 'INVENTORY_MOVEMENT';
