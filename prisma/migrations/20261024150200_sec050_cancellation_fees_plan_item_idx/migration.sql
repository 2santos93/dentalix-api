-- SEC-050: el plan de tratamiento (detalle, edición de ítems) dice qué ítem es
-- un cargo por cancelación vigente buscando `cancellation_fees` por
-- `planItemId` (sin el paciente: no sirve el índice de la FK, que empieza por
-- tenantId, patientId). Parcial: una condonación no tiene ítem. CONCURRENTLY,
-- única sentencia. Aditivo.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "cancellation_fees_plan_item_idx" ON "cancellation_fees" ("planItemId") WHERE "planItemId" IS NOT NULL;
