-- CONCURRENTLY con otra sentencia: Prisma lo mete en una transacción y falla.
SET lock_timeout = '5s';
CREATE INDEX CONCURRENTLY "appointments_tenant_chair_idx" ON "appointments" ("tenantId", "chairId");
