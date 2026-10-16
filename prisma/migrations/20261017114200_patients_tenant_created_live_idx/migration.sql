-- DX-043 (DB-005): página del listado de pacientes sin Sort, orden (createdAt
-- DESC, id DESC). CONCURRENTLY, única sentencia del fichero (ver 20261017114100).
CREATE INDEX CONCURRENTLY "patients_tenant_created_live_idx" ON "patients" ("tenantId", "createdAt" DESC, "id" DESC) WHERE "deletedAt" IS NULL;
