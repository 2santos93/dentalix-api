-- DX-015-bis: suelta el índice de la lista de recall sin "visitLocationId"
-- (20261212090300); lo sustituye "patient_recalls_tenant_due_visit_idx"
-- (20261212090600). CONCURRENTLY: única sentencia del fichero.
-- Para volver atrás: recrear el de 20261212090300 (CONCURRENTLY).
DROP INDEX CONCURRENTLY IF EXISTS "patient_recalls_tenant_due_idx";
