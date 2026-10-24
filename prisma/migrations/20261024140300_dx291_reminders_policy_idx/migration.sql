-- DX-291: lado hijo de la FK compuesta (tenantId, policyVersionId) de
-- `appointment_reminders` hacia la versión de la política enviada en el
-- recordatorio. Parcial: solo los enviados con política. CONCURRENTLY, única
-- sentencia. Aditivo.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "appointment_reminders_tenant_policy_version_idx" ON "appointment_reminders" ("tenantId", "policyVersionId") WHERE "policyVersionId" IS NOT NULL;
