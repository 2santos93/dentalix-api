-- DX-051: destino de las FK compuestas ("tenantId", "treatmentPlanItemId",
-- "treatmentPlanId") de payment_allocations y payment_allocation_movements: el
-- ítem imputado es de la MISMA clínica y del MISMO plan que el abono.
-- CONCURRENTLY (DB-025): no bloquea las escrituras de los planes; por eso es
-- la ÚNICA sentencia del fichero (Prisma la ejecuta fuera de transacción).
-- Si falla deja un índice INVALID: DROP INDEX CONCURRENTLY,
-- `prisma migrate resolve --rolled-back` y reintentar.
CREATE UNIQUE INDEX CONCURRENTLY "treatment_plan_items_tenant_id_plan_key" ON "treatment_plan_items"("tenantId", "id", "planId");
