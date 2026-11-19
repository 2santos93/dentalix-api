-- DX-562: las citas de una serie en orden, una por posición, y lado hijo de
-- la FK appointments_series_fkey (20270116140100). Parcial: solo las de una
-- serie. CONCURRENTLY para no bloquear las escrituras de appointments (tabla
-- caliente, DX-148), única sentencia (no puede ir en transacción), como
-- 20261227090100_dx263_appointments_import_batch_idx. Aditivo: la columna
-- nace entera a NULL, así que el índice nace vacío.
-- Si se corta, deja un índice INVALID: el IF NOT EXISTS no lo repara; hay que
-- DROP INDEX CONCURRENTLY y repetirla.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "appointments_tenant_series_index_key" ON "appointments" ("tenantId", "seriesId", "seriesIndex") WHERE "seriesId" IS NOT NULL;
