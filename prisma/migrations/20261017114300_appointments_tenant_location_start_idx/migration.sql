-- DX-043 (DB-006): agenda por sede y semana. NO parcial: también es el lado
-- hijo de la FK compuesta (tenantId, locationId) y sustituye a
-- appointments_tenantId_locationId_idx. CONCURRENTLY, única sentencia.
CREATE INDEX CONCURRENTLY "appointments_tenant_location_start_idx" ON "appointments" ("tenantId", "locationId", "start");
