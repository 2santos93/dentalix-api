-- DX-172: el informe de captación (pacientes nuevos por fuente y período).
-- "patients" es tabla caliente (DX-148): CONCURRENTLY, sola en su fichero.
-- Parcial como los de DX-043: el informe solo cuenta pacientes vivos.
-- Vuelta atrás: DROP INDEX CONCURRENTLY "patients_tenant_source_created_idx".
CREATE INDEX CONCURRENTLY IF NOT EXISTS "patients_tenant_source_created_idx" ON "patients"("tenantId", "sourceId", "createdAt") WHERE "deletedAt" IS NULL;
