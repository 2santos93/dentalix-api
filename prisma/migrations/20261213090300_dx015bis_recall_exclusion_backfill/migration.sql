-- DX-015-bis (porción 2): datos, sin DDL. El relleno único de la exclusión
-- (D10): en cada clínica, de los recalls activos de un paciente cuyos tipos
-- comparten grupo se queda activo uno (dx_recall_exclusion_backfill, en
-- 20261213090200) y los demás pasan a inactivos con "excludedAt". No borra
-- nada.
--
-- Una única sentencia (DO): `prisma migrate deploy` la ejecuta fuera de un
-- bloque de transacción, así que cada COMMIT cierra una clínica. Sin NO
-- FORCE: con un owner sin superusuario ni BYPASSRLS (DX-113) la RLS le
-- aplica, así que fija `app.current_tenant` en cada clínica.
--
-- Si se corta a mitad, las clínicas hechas quedan; repetirla
-- (`prisma migrate resolve --rolled-back` y `deploy`) no cambia nada en ellas.
-- Lo que la app vieja deje con dos activos mientras tanto lo corrige el
-- siguiente DONE o PUT de ese paciente (la app nueva aplica la exclusión en
-- cada evento).
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
    PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
    PERFORM public.dx_recall_exclusion_backfill(t);
    COMMIT;
  END LOOP;
END
$$;
