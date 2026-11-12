-- DX-015-bis: datos, sin DDL. Rellena patient_recalls."visitLocationId"
-- (20261212090400) clínica a clínica. Los triggers ya están puestos, así que
-- lo que se escriba mientras tanto ya queda bien; repetirla no cambia nada
-- (solo escribe lo que difiere).
--
-- Una única sentencia (DO): `prisma migrate deploy` la ejecuta fuera de un
-- bloque de transacción, así que cada COMMIT cierra una clínica. Sin NO
-- FORCE: con un owner sin superusuario ni BYPASSRLS (DX-113) la RLS le
-- aplica, así que fija `app.current_tenant` en cada clínica.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
    PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
    -- El BEFORE de patient_recalls no repite la búsqueda por fila (20261212090400).
    PERFORM pg_catalog.set_config('dentalix.recall_visit_refresh', 'on', true);
    -- Por el índice parcial, sin sort (ver dx_recall_visit_location_refresh).
    PERFORM pg_catalog.set_config('enable_sort', 'off', true);
    PERFORM pg_catalog.set_config('enable_incremental_sort', 'off', true);
    -- Sin join (DX-294-ter, ver dx_recall_visit_location_refresh en
    -- 20261212090400): lineal sea cual sea la estimación.
    UPDATE public."patient_recalls" pr
       SET "visitLocationId" = (
             SELECT a."locationId"
               FROM public."appointments" a
              WHERE a."tenantId" = pr."tenantId"
                AND a."patientId" = pr."patientId"
                AND a."status" = 'COMPLETED'
                AND a."deletedAt" IS NULL
              ORDER BY a."start" DESC, a."id" DESC
              LIMIT 1)
     WHERE pr."tenantId" = t
       AND pr."visitLocationId" IS DISTINCT FROM (
             SELECT a."locationId"
               FROM public."appointments" a
              WHERE a."tenantId" = pr."tenantId"
                AND a."patientId" = pr."patientId"
                AND a."status" = 'COMPLETED'
                AND a."deletedAt" IS NULL
              ORDER BY a."start" DESC, a."id" DESC
              LIMIT 1);
    COMMIT;
  END LOOP;
END
$$;
