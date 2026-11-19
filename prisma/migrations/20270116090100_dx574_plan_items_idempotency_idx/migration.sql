-- DX-574: único parcial de la Idempotency-Key de los ítems del plan.
-- "treatment_plan_items" es tabla caliente (DX-148): CONCURRENTLY, sola en su
-- fichero, para no bloquear escrituras. Ninguna fila tiene clave todavía.
-- Vuelta atrás: DROP INDEX CONCURRENTLY "treatment_plan_items_tenant_idempotency_key".
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "treatment_plan_items_tenant_idempotency_key" ON "treatment_plan_items"("tenantId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
