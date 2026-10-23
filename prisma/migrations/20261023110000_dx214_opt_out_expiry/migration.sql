BEGIN;
SET LOCAL lock_timeout = '10s';
-- DX-214: no se alteran las políticas ni FORCE RLS.
ALTER TABLE "reminder_opt_out_links" ADD COLUMN "expiresAt" TIMESTAMP(3);
-- También funciona con migrador owner NOSUPERUSER NOBYPASSRLS y FORCE activa.
DO $$
DECLARE clinic RECORD;
DECLARE previous_tenant TEXT := current_setting('app.current_tenant', true);
BEGIN
  FOR clinic IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', clinic.id::text, true);
    UPDATE "reminder_opt_out_links" SET "expiresAt" = "createdAt" + INTERVAL '60 days'
      WHERE "tenantId" = clinic.id;
  END LOOP;
  PERFORM set_config('app.current_tenant', COALESCE(previous_tenant, ''), true);
END $$;
ALTER TABLE "reminder_opt_out_links" ALTER COLUMN "expiresAt" SET NOT NULL;
ALTER TABLE "reminder_opt_out_links" ALTER COLUMN "expiresAt" SET DEFAULT (now() + INTERVAL '60 days');
CREATE INDEX "reminder_opt_out_links_tenantId_expiresAt_idx" ON "reminder_opt_out_links"("tenantId", "expiresAt");
CREATE INDEX "reminder_opt_out_links_tenantId_usedAt_idx" ON "reminder_opt_out_links"("tenantId", "usedAt");
COMMIT;
