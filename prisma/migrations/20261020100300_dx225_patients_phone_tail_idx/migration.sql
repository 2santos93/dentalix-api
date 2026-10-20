-- DX-225: pacientes vivos de un móvil (respuesta «BAJA», DX-126), por
-- "phoneTail" (columna comparada con `=`, que sí es condición de índice bajo
-- RLS). Parcial: solo vivos y con teléfono. CONCURRENTLY para no bloquear las
-- escrituras de patients; única sentencia (no puede ir en transacción).
-- Aditivo. Si se corta, deja un índice INVALID: el IF NOT EXISTS no lo
-- repara; hay que DROP INDEX CONCURRENTLY y repetirla.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "patients_tenant_phone_tail_idx" ON "patients" ("tenantId", "phoneTail") WHERE "deletedAt" IS NULL AND "phoneTail" IS NOT NULL;
