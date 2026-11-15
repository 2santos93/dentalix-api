-- DX-263: citas de un lote de importación (deshacer, recordatorios) y lado
-- hijo de la FK appointments_import_batch_fkey (20261227090000). Parcial:
-- solo las importadas. CONCURRENTLY para no bloquear las escrituras de
-- appointments (tabla caliente, DX-148), única sentencia (no puede ir en
-- transacción), como 20261022130300_dx107_patients_import_batch_idx. Aditivo.
-- Si se corta, deja un índice INVALID: el IF NOT EXISTS no lo repara; hay que
-- DROP INDEX CONCURRENTLY y repetirla.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "appointments_tenant_import_batch_idx" ON "appointments" ("tenantId", "import_batch_id") WHERE "import_batch_id" IS NOT NULL;
