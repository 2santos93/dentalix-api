-- DX-251 (OPS-037): segunda pasada de 20261020200050_dx251_rls_tenant_guc_nullif
-- para las políticas creadas después de ella con el cast directo
-- `current_setting('app.current_tenant', true)::uuid`: patient_documents
-- (DX-151), payers y patient_coverages (DX-153) y los horarios de los
-- profesionales y sus excepciones (DX-233). Mismo bloque (idempotente): solo
-- toca las que aún no llevan NULLIF y falla si queda alguna.
--
-- Desde aquí, las migraciones nuevas escriben ya
--   "tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
-- (lo vigila test/migrations/tenant-guc-nullif.spec.ts).
DO $$
DECLARE
  -- Forma que deja Postgres al guardar `current_setting('app.current_tenant',
  -- true)::uuid` (pg_get_expr) y su sustituta con NULLIF.
  v_old constant text := '(current_setting(''app.current_tenant''::text, true))::uuid';
  v_new constant text := '(NULLIF(current_setting(''app.current_tenant''::text, true), ''''::text))::uuid';
  p record;
  v_sql text;
BEGIN
  PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
  FOR p IN
    SELECT pol.polname, pol.polrelid::regclass AS rel,
           pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS qual,
           pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS wcheck
      FROM pg_catalog.pg_policy pol
      JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
     ORDER BY pol.polrelid, pol.polname
  LOOP
    CONTINUE WHEN pg_catalog.strpos(coalesce(p.qual, ''), v_old) = 0
              AND pg_catalog.strpos(coalesce(p.wcheck, ''), v_old) = 0;
    v_sql := pg_catalog.format('ALTER POLICY %I ON %s', p.polname, p.rel);
    IF p.qual IS NOT NULL THEN
      v_sql := v_sql || pg_catalog.format(' USING (%s)', pg_catalog.replace(p.qual, v_old, v_new));
    END IF;
    IF p.wcheck IS NOT NULL THEN
      v_sql := v_sql || pg_catalog.format(' WITH CHECK (%s)', pg_catalog.replace(p.wcheck, v_old, v_new));
    END IF;
    EXECUTE v_sql;
  END LOOP;

  -- Ninguna política de public debe quedar con el cast directo.
  PERFORM 1
     FROM pg_catalog.pg_policy pol
     JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND (pg_catalog.strpos(coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), ''), v_old) > 0
        OR pg_catalog.strpos(coalesce(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), ''), v_old) > 0);
  IF FOUND THEN
    RAISE EXCEPTION 'DX-251: quedan políticas con current_setting(''app.current_tenant'', true)::uuid sin NULLIF';
  END IF;
END
$$;
