-- DX-015-bis: datos, por clínica (también las retiradas: sus recalls necesitan
-- tipo), sin DDL.
--
-- Una única sentencia (DO): `prisma migrate deploy` la ejecuta fuera de un
-- bloque de transacción, así que cada COMMIT cierra una clínica. Por cada una:
--   1. Los tres tipos por defecto (dx_recall_seed_default_types, D2), con sus
--      disparadores si el ítem de catálogo sigue vivo.
--   2. El relleno (dx_recall_backfill, horizonte de 24 meses, D3): el tipo
--      desde "kind", la base congelada (nadie entra ni sale de la lista por
--      el cambio de regla), el historial de DONE de los disparadores y los
--      recalls nuevos de source BACKFILL.
--
-- Sin NO FORCE: con un owner sin superusuario ni BYPASSRLS (DX-113) la RLS le
-- aplica, así que fija `app.current_tenant` en cada clínica (set_config(...,
-- true) dura lo que la transacción, y se vuelve a fijar tras cada COMMIT).
--
-- Si se corta a mitad, las clínicas hechas quedan; repetirla
-- (`prisma migrate resolve --rolled-back` y `deploy`) no duplica tipos (la
-- siembra es idempotente) y el relleno salta las clínicas ya hechas (solo
-- toca recalls sin tipo o sin "manualDoneAt"; los BACKFILL se crean solo si
-- falta el recall de ese tipo).
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
    PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
    PERFORM public.dx_recall_seed_default_types(t);
    PERFORM public.dx_recall_backfill(t, 24);
    COMMIT;
  END LOOP;
END
$$;
