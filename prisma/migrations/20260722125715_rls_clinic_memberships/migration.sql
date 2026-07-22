-- Habilitar RLS y forzarla incluso para el owner de la tabla
ALTER TABLE "clinic_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clinic_memberships" FORCE ROW LEVEL SECURITY;

-- Aislamiento por tenant: solo filas del tenant en contexto.
-- current_setting(..., true) => NULL si no hay contexto => 0 filas (fail-safe).
CREATE POLICY tenant_isolation ON "clinic_memberships"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
