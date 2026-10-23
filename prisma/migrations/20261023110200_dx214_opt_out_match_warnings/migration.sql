-- DX-214 I1: aviso durable para recepción; sin nombres, móviles o actor ficticio.
BEGIN;
SET LOCAL lock_timeout = '10s';
CREATE TABLE "reminder_opt_out_match_warnings" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "patientId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "matchCount" INTEGER NOT NULL,
  "maxMatches" INTEGER NOT NULL,
  CONSTRAINT "reminder_opt_out_match_warnings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "opt_out_match_warnings_count_check" CHECK ("maxMatches" >= 1 AND "matchCount" > "maxMatches"),
  CONSTRAINT "opt_out_match_warnings_tenant_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "opt_out_match_warnings_patient_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "opt_out_match_warnings_tenant_patient_recent_idx" ON "reminder_opt_out_match_warnings"("tenantId", "patientId", "createdAt" DESC, "id" DESC);
ALTER TABLE "reminder_opt_out_match_warnings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reminder_opt_out_match_warnings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "reminder_opt_out_match_warnings"
 USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
 WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "reminder_opt_out_match_warnings" TO dentalix_app;
-- Reutiliza la guardia append-only: UPDATE prohibido; DELETE/TRUNCATE solo limpieza superusuario.
CREATE TRIGGER "opt_out_match_warnings_immutable" BEFORE UPDATE OR DELETE ON "reminder_opt_out_match_warnings"
 FOR EACH ROW EXECUTE FUNCTION "dx_forbid_audit_mutation"();
CREATE TRIGGER "opt_out_match_warnings_no_truncate" BEFORE TRUNCATE ON "reminder_opt_out_match_warnings"
 FOR EACH STATEMENT EXECUTE FUNCTION "dx_forbid_audit_mutation"();
COMMIT;
