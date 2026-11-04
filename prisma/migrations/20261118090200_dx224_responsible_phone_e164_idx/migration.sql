-- DX-224: índice de contactos responsables por E.164 (una sentencia por fichero:
-- CONCURRENTLY no puede ir en transacción). Aditivo; ver 20261118090100.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "patient_responsible_parties_tenant_phone_e164_idx" ON "patient_responsible_parties" ("tenantId", "phoneE164") WHERE "deletedAt" IS NULL AND "phoneE164" IS NOT NULL;
