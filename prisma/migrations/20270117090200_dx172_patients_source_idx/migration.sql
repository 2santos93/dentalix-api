-- DX-172: el informe de captación (pacientes nuevos por fuente y período).
-- "patients" es tabla caliente (DX-148): CONCURRENTLY, sola en su fichero.
-- NO parcial a propósito: con `WHERE "deletedAt" IS NULL` el planificador lo
-- usaría para cualquier «pacientes vivos» y competiría con el trigram de la
-- búsqueda (patient-search.int-spec: el LIKE tiene que ser Index Cond del
-- trigram). El informe filtra `deletedAt` aparte (pocos archivados).
-- Vuelta atrás: DROP INDEX CONCURRENTLY "patients_tenant_source_created_idx".
CREATE INDEX CONCURRENTLY IF NOT EXISTS "patients_tenant_source_created_idx" ON "patients"("tenantId", "sourceId", "createdAt");
