-- DX-191: destino de la FK compuesta (tenantId, treatmentPlanItemId) de
-- patient_implants: el ítem del plan al que se liga un implante tiene que ser
-- de la MISMA clínica (las FK de Postgres se chequean saltando la RLS).
-- CONCURRENTLY (DB-025): no bloquea las escrituras de los planes; por eso es
-- la ÚNICA sentencia del fichero (Prisma la ejecuta fuera de transacción).
-- Si falla deja un índice INVALID: DROP INDEX CONCURRENTLY,
-- `prisma migrate resolve --rolled-back` y reintentar.
CREATE UNIQUE INDEX CONCURRENTLY "treatment_plan_items_tenant_id_key" ON "treatment_plan_items"("tenantId", "id");
