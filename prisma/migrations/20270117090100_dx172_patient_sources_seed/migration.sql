-- DX-172: las fuentes de captación por defecto en cada clínica, sin DDL.
--
-- Una única sentencia (DO): `prisma migrate deploy` la ejecuta fuera de un
-- bloque de transacción, así que cada COMMIT cierra una clínica (molde de
-- 20261212090100). Sin NO FORCE: con un owner sin superusuario ni BYPASSRLS
-- (DX-113) la RLS le aplica, así que fija `app.current_tenant` en cada
-- clínica. También las retiradas: no cuesta nada y su catálogo queda igual.
--
-- Repetirla no duplica nada: dx_patient_sources_ensure solo siembra una
-- clínica sin ninguna fuente.
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
    PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
    PERFORM public.dx_patient_sources_ensure(t);
    COMMIT;
  END LOOP;
END
$$;
