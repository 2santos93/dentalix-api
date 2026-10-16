-- DX-043 (DB-006/DB-008): agenda consolidada y «próximas citas» del
-- dashboard. CONCURRENTLY, única sentencia.
CREATE INDEX CONCURRENTLY "appointments_tenant_start_live_idx" ON "appointments" ("tenantId", "start") WHERE "deletedAt" IS NULL;
