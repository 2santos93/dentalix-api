-- DX-224 (ronda 2): lo mismo para los contactos responsables (ver 20261118100100).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "patient_responsible_parties_tenant_phone_e164_pending_idx" ON "patient_responsible_parties" ("tenantId", "id") WHERE "phone" IS NOT NULL AND "phoneE164" IS NULL AND "phoneE164CheckedAt" IS NULL;
