-- DX-132: nuevo único del espejo del plan (ver 20270206140000). NULLS NOT
-- DISTINCT: la primera copia de un ítem (replacesRecordId NULL) sigue siendo
-- única, como con "tooth_records_source_plan_item_key" (DB-013), y cada
-- re-copia lleva el id de la copia anulada que sustituye. Se crea antes de
-- retirar el viejo: la tabla nunca queda sin respaldo.
-- "tooth_records" es tabla caliente (DX-148): CONCURRENTLY, sola en su fichero.
-- IF NOT EXISTS: idempotente.
-- Vuelta atrás: DROP INDEX CONCURRENTLY "tooth_records_source_plan_item_mirror_key".
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "tooth_records_source_plan_item_mirror_key" ON "tooth_records" ("tenantId", "sourcePlanItemId", "replacesRecordId") NULLS NOT DISTINCT WHERE "sourcePlanItemId" IS NOT NULL AND "deletedAt" IS NULL;
