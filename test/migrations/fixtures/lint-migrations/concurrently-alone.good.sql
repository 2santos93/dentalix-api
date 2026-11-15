-- Única sentencia: ni siquiera un SET (iría en la misma transacción).
DROP INDEX CONCURRENTLY IF EXISTS "appointments_tenant_chair_idx";
