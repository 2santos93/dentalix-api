-- DX-043 (DB-017): índice redundante, prefijo exacto del btree no parcial
-- tooth_records_tenantId_patientId_toothNumber_idx, que cubre las mismas búsquedas y el lado hijo de la FK.
-- CONCURRENTLY (no bloquea lecturas ni escrituras), única sentencia del fichero.
DROP INDEX CONCURRENTLY IF EXISTS "tooth_records_tenantId_patientId_idx";
