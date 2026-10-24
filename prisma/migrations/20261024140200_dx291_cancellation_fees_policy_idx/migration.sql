-- DX-291: lado hijo de la FK compuesta (tenantId, policyVersionId) de
-- `cancellation_fees` hacia la versión de la política. Parcial: una
-- condonación puede no tener versión comunicada. CONCURRENTLY, única
-- sentencia. Aditivo.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "cancellation_fees_tenant_policy_version_idx" ON "cancellation_fees" ("tenantId", "policyVersionId") WHERE "policyVersionId" IS NOT NULL;
