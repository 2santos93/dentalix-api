-- DX-279: lado hijo de la FK compuesta (tenantId, policyVersionId) hacia
-- `cancellation_policy_versions`. Parcial: solo las citas con versión
-- comunicada (DX-291 la rellena). CONCURRENTLY, única sentencia. Aditivo.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "appointments_tenant_policy_version_idx" ON "appointments" ("tenantId", "policyVersionId") WHERE "policyVersionId" IS NOT NULL;
