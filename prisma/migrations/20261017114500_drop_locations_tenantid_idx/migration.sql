-- DX-043 (DB-017): índice redundante, prefijo exacto del btree no parcial
-- locations_tenant_id_key (tenantId, id), que cubre las mismas búsquedas y el lado hijo de la FK.
-- CONCURRENTLY (no bloquea lecturas ni escrituras), única sentencia del fichero.
DROP INDEX CONCURRENTLY IF EXISTS "locations_tenantId_idx";
