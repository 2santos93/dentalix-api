-- DX-211: lado hijo de la FK compuesta (tenantId, locationId, chairId) hacia
-- `chairs` y filtro `chairIds` de la agenda. Parcial: solo las citas con
-- sillón (las clínicas sin sillones no pagan nada). CONCURRENTLY, única
-- sentencia. Aditivo. Vuelta atrás: DROP INDEX CONCURRENTLY.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "appointments_tenant_location_chair_start_idx" ON "appointments" ("tenantId", "locationId", "chairId", "start") WHERE "chairId" IS NOT NULL;
