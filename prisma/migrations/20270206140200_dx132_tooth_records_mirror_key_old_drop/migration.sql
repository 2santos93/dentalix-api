-- DX-132: retira el único viejo del espejo (DB-013, 20261016130000), que
-- impedía la re-copia tras una anulación; lo sustituye
-- "tooth_records_source_plan_item_mirror_key" (20270206140100).
-- CONCURRENTLY, solo en su fichero (tabla caliente, DX-148).
-- Vuelta atrás: CREATE UNIQUE INDEX CONCURRENTLY "tooth_records_source_plan_item_key"
--   ON "tooth_records" ("tenantId", "sourcePlanItemId")
--   WHERE "sourcePlanItemId" IS NOT NULL AND "deletedAt" IS NULL;
-- (solo si no hay re-copias).
DROP INDEX CONCURRENTLY IF EXISTS "tooth_records_source_plan_item_key";
