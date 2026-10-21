-- DX-251 (OPS-037): políticas de RLS tolerantes a `app.current_tenant` VACÍO.
--
-- `set_config('app.current_tenant', …, true)` dura lo que la transacción, pero
-- al terminar la variable no vuelve a NULL: queda en '' el resto de la
-- sesión. `prisma migrate deploy` aplica todas las migraciones pendientes en
-- UNA sesión: tras el backfill de DX-225 (20261020100200, que fija la clínica
-- por lotes) las siguientes corren con ''. La FK de patient_documents hacia
-- patients (DX-151, 20261020200100) se valida como el owner con la RLS FORCE
-- de patients, y `''::uuid` lanzaba 22P02 en cuanto había pacientes: con un
-- owner sin superusuario (Postgres gestionado) el despliegue quedaba a medias
-- (P3018) y el job owner-nosu en rojo.
--
-- Arreglo de fondo, sin editar migraciones ya aplicadas (no cambia ningún
-- checksum): toda política de public que hace
--   "tenantId" = current_setting('app.current_tenant', true)::uuid
-- pasa a
--   "tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
-- Con la variable vacía compara con NULL y NIEGA la fila, igual que sin
-- clínica fijada: nunca abre filas de ninguna clínica. Un valor que no es
-- uuid sigue fallando (22P02), como antes.
--
-- Va ANTES de 20261020200100_dx151_patient_documents para que un despliegue
-- desde cero (o uno que traiga DX-225 y DX-151 a la vez) valide esa FK sin
-- error. En una base que ya tiene DX-151 y siguientes, `migrate deploy` la
-- aplica igualmente (intercalada; no pide reset). Las políticas que crean
-- DX-151, DX-153 y DX-233 las reescribe 20261020230000_dx251_…_rest con el
-- mismo bloque; el lint test/migrations/tenant-guc-nullif.spec.ts impide el
-- cast directo en migraciones posteriores, y test/rls-catalog.int-spec.ts
-- exige la forma con NULLIF en todas las políticas de clínica.
--
-- Reescritura genérica: lee cada política de public (pg_get_expr) y cambia
-- solo esa subexpresión con ALTER POLICY (mismo nombre, comando y roles). Un
-- solo DO: o entran todas o ninguna. ALTER POLICY toma ACCESS EXCLUSIVE en
-- cada tabla durante la transacción (milisegundos, sin reescribir datos), con
-- lock_timeout de 5 s: si choca con tráfico, falla limpio y se repite
-- (`prisma migrate resolve --rolled-back` + `deploy`; es idempotente).
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

-- Las particiones nuevas de audit_events (audit_events_ensure_partitions, al
-- arrancar la API y cada mes) reciben su política de dx_audit_events_harden:
-- misma función que en 20261017130000_audit_events_partitioned, con NULLIF.
-- CREATE OR REPLACE conserva el owner y los privilegios (REVOKE … FROM PUBLIC).
CREATE OR REPLACE FUNCTION dx_audit_events_harden(p_rel regclass) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  g record;
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_rel);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_rel);
  IF NOT EXISTS (SELECT 1 FROM pg_policy
                 WHERE polrelid = p_rel AND polname = 'tenant_isolation') THEN
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s '
      'USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) '
      'WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      p_rel);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = p_rel AND tgname = 'audit_events_no_truncate') THEN
    EXECUTE format(
      'CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON %s '
      'FOR EACH STATEMENT EXECUTE FUNCTION dx_forbid_audit_mutation()', p_rel);
  END IF;
  FOR g IN
    SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                         ELSE quote_ident(r.rolname) END AS who
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    LEFT JOIN pg_roles r ON r.oid = a.grantee
    WHERE c.oid = p_rel
      AND a.grantee <> c.relowner
      AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, TRIGGER ON %s FROM %s',
                   p_rel, g.who);
  END LOOP;
END;
$$;
