-- CREATE INDEX sin CONCURRENTLY sobre una tabla caliente.
SET LOCAL lock_timeout = '5s';
CREATE INDEX "patients_tenant_birth_idx" ON "patients" ("tenantId", "birthDate");
