-- DX-107: pacientes de un lote de importación (deshacer) y lado hijo de la FK
-- patients_import_batch_fkey (20261022130100). Parcial: solo los importados.
-- CONCURRENTLY para no bloquear las escrituras de patients (revisión
-- 2026-10-23, I3; como 20261020100300_dx225_patients_phone_tail_idx); única
-- sentencia (no puede ir en transacción). Aditivo: el código anterior no lo
-- usa. Si se corta, deja un índice INVALID: el IF NOT EXISTS no lo repara; hay
-- que DROP INDEX CONCURRENTLY y repetirla.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "patients_tenant_import_batch_idx" ON "patients" ("tenantId", "import_batch_id") WHERE "import_batch_id" IS NOT NULL;
