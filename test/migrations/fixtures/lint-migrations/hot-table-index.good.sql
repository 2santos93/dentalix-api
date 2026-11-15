-- CONCURRENTLY, única sentencia del fichero: Prisma la ejecuta fuera de
-- transacción. Si falla deja un índice INVALID (README, runbook).
CREATE INDEX CONCURRENTLY "patients_tenant_birth_idx" ON "patients" ("tenantId", "birthDate");
