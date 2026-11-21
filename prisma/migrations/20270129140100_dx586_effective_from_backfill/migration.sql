-- DX-586: relleno de "manual_exchange_rates"."effectiveFrom" en las tasas
-- anteriores: el inicio de su día civil en la zona de la sede principal de la
-- clínica (dx_manual_rate_day_start, la misma regla del trigger que la pone
-- cuando una réplica anterior inserta sin ella). Así cada tasa antigua rige
-- todo su día, como hasta ahora.
--
-- Sin DDL. Una única sentencia (DO): `prisma migrate deploy` la ejecuta fuera
-- de un bloque de transacción y cada COMMIT cierra una clínica (la tabla es
-- pequeña: como mucho unas pocas tasas por clínica y día). Molde de
-- 20261102120100_dx375_payment_exchange_rate_backfill: sin NO FORCE, con un
-- owner sin BYPASSRLS (DX-113) la RLS le aplica, así que fija
-- `app.current_tenant` en cada clínica (también para leer su sede).
--
-- Idempotente: solo toca filas con la columna NULL. Si se corta a mitad, basta
-- con repetirla (`prisma migrate resolve --rolled-back
-- 20270129140100_dx586_effective_from_backfill` y `deploy`).
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
    PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
    UPDATE public."manual_exchange_rates" m
       SET "effectiveFrom" = public.dx_manual_rate_day_start(m."tenantId", m."date")
     WHERE m."tenantId" = t
       AND m."effectiveFrom" IS NULL;
    COMMIT;
  END LOOP;
END
$$;
