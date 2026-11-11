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
    UPDATE public."patient_recalls" pr
       SET "visitLocationId" = v."locationId"
      FROM (SELECT r."id",
                   (SELECT a."locationId"
                      FROM public."appointments" a
                     WHERE a."tenantId" = r."tenantId"
                       AND a."patientId" = r."patientId"
                       AND a."status" = 'COMPLETED'
                       AND a."deletedAt" IS NULL
                     ORDER BY a."start" DESC, a."id" DESC
                     LIMIT 1) AS "locationId"
              FROM public."patient_recalls" r
             WHERE r."tenantId" = t) v
     WHERE pr."id" = v."id"
       AND pr."visitLocationId" IS DISTINCT FROM v."locationId";
    COMMIT;
  END LOOP;
END
$$;
