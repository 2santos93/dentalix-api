-- DX-043: búsqueda (dx_patient_search_ids/_count). GIN compuesto con btree_gin:
-- el bitmap ya sale limitado al tenant (revisión M4). CONCURRENTLY: no bloquea
-- escrituras; por eso es la ÚNICA sentencia del fichero (Prisma la ejecuta
-- fuera de transacción). Si falla deja un índice INVALID: DROP INDEX
-- CONCURRENTLY, `prisma migrate resolve --rolled-back` y reintentar.
CREATE INDEX CONCURRENTLY "patients_search_text_trgm_live_idx" ON "patients" USING gin ("tenantId", "search_text" gin_trgm_ops) WHERE "deletedAt" IS NULL;
