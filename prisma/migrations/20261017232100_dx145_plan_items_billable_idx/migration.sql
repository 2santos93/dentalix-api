-- DX-145: la cartera por antigüedad suma el facturable (precio − descuento de
-- los ítems vivos ACCEPTED|DONE) de TODOS los planes de la clínica en una
-- consulta. Índice parcial (solo ítems vivos) que cubre precio, descuento y
-- estado: la suma sale con un Index Only Scan, sin visitar la tabla
-- (docs/perf/DX-145.md). Aditivo; CONCURRENTLY, única sentencia.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "treatment_plan_items_tenant_plan_billable_idx" ON "treatment_plan_items" ("tenantId", "planId") INCLUDE ("price", "discount", "status") WHERE "deletedAt" IS NULL;
