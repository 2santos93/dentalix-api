-- DX-224: índices de la búsqueda por teléfono. Parciales (solo vivos y con
-- E.164), por (tenant, E.164): `=` sobre la columna es condición de índice
-- también bajo RLS. CONCURRENTLY: no bloquea las escrituras y no puede ir en
-- transacción, así que una sentencia por fichero (el de responsables es el
-- 20261118090200).
-- Aditivo. Si se corta, deja un índice INVALID: hay que DROP INDEX
-- CONCURRENTLY y repetirla.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "patients_tenant_phone_e164_idx" ON "patients" ("tenantId", "phoneE164") WHERE "deletedAt" IS NULL AND "phoneE164" IS NOT NULL;
