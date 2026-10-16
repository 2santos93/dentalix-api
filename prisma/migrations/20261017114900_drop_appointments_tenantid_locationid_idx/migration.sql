-- DX-043 (DB-017): índice redundante, prefijo exacto del btree no parcial
-- appointments_tenant_location_start_idx (20261017114300), que cubre las mismas búsquedas y el lado hijo de la FK.
-- CONCURRENTLY (no bloquea lecturas ni escrituras), única sentencia del fichero.
DROP INDEX CONCURRENTLY IF EXISTS "appointments_tenantId_locationId_idx";
