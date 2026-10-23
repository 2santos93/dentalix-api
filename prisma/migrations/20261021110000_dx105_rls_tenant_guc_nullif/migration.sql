-- DX-105 + DX-251: repair installations that already applied the original
-- DX-105 policies. Fresh installs also use NULLIF in the creating migration.
-- An empty transaction-local tenant denies access instead of casting '' to UUID.
SET lock_timeout = '5s';

ALTER POLICY tenant_isolation ON "price_lists"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER POLICY tenant_isolation ON "price_list_items"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER POLICY tenant_isolation ON "agreements"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER POLICY tenant_isolation ON "patient_agreements"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

