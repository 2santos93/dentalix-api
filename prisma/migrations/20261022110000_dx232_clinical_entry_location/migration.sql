-- DX-232: sede persistida, backfill solo desde cita. Migración owner atómica.
-- Suspensión exclusiva del trigger de UPDATE/DELETE mientras ACCESS EXCLUSIVE
-- protege la tabla. No se cambia ninguna nota ni snapshot de diagnóstico.
BEGIN;
ALTER TABLE "clinical_entries" ADD COLUMN "locationId" UUID;
ALTER TABLE "clinical_entries" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "locations" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "clinical_entries" DISABLE TRIGGER "clinical_entries_immutable";
-- DX232_BACKFILL_START
DO $$
DECLARE changed integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT e.id, a."locationId"
      FROM "clinical_entries" e
      JOIN "appointments" a ON a."tenantId" = e."tenantId"
        AND a."patientId" = e."patientId" AND a.id = e."appointmentId"
      WHERE e."locationId" IS NULL
      ORDER BY e.id
      LIMIT 1000
    )
    UPDATE "clinical_entries" e SET "locationId" = batch."locationId"
      FROM batch WHERE e.id = batch.id;
    GET DIAGNOSTICS changed = ROW_COUNT;
    EXIT WHEN changed = 0;
  END LOOP;
END;
$$;
-- DX232_BACKFILL_END
ALTER TABLE "clinical_entries" ENABLE TRIGGER "clinical_entries_immutable";
CREATE INDEX "clinical_entries_tenant_location_idx"
  ON "clinical_entries" ("tenantId", "locationId") WHERE "locationId" IS NOT NULL;
ALTER TABLE "clinical_entries" ADD CONSTRAINT "clinical_entries_tenantId_locationId_fkey"
  FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "clinical_entries" FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;
ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;
COMMIT;
