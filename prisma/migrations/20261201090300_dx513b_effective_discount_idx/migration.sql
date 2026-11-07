-- DX-513-bis (2/2): el índice parcial del informe de descuentos con el
-- predicado nuevo, el mismo texto que usa la consulta del informe
-- (prisma-discount-report.repository.ts). PARCIAL y de expresión: no
-- declarable en Prisma (ver schema.prisma).
--
-- CONCURRENTLY, única sentencia (no puede ir en transacción). Si se corta,
-- deja un índice INVALID: el IF NOT EXISTS no lo repara; hay que DROP INDEX
-- CONCURRENTLY y repetirla.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "treatment_plan_items_tenant_effective_discount_at_idx" ON "treatment_plan_items" ("tenantId", (COALESCE("discountAt", "createdAt"))) WHERE ("discount" > 0 OR "price" < "catalogPrice" OR "price" < "referencePriceInPlan") AND "deletedAt" IS NULL;
