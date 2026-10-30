-- DX-380: relleno de `payment_base_retries` con los abonos que YA esperan su
-- tasa o su base (el trigger solo ve las altas nuevas). Mismo predicado que
-- el trigger: vivos y «sin tasa» (o anteriores sin congelar) o, a un plan
-- vivo, sin base. "createdAt" es el alta del abono (el aviso al ADMIN cuenta
-- desde ahí) y "nextAttemptAt" ahora: el barrido los toma en su primera
-- pasada, 50 por clínica y minuto, el que lleva más tiempo esperando primero.
-- Molde de 20261102120100_dx375_payment_exchange_rate_backfill.
--
-- Una única sentencia (DO): `prisma migrate deploy` la ejecuta fuera de un
-- bloque de transacción, así que cada COMMIT cierra un lote de 2.000 abonos.
-- Solo lee `payments`, `treatment_plans` y `payment_plan_amounts` (sin
-- bloqueos de fila) e inserta en la tabla nueva. Recorrido por cursor
-- (tenantId, id > último).
--
-- Sin NO FORCE: con un owner sin superusuario ni BYPASSRLS (DX-113) la RLS
-- le aplica, así que recorre las clínicas y fija `app.current_tenant` en cada
-- lote (vuelve a fijarse tras cada COMMIT).
--
-- Idempotente (ON CONFLICT DO NOTHING). Si se corta a mitad, basta con
-- repetirla (`prisma migrate resolve --rolled-back
-- 20261104120400_dx380_payment_base_retries_backfill` y `deploy`).
DO $$
DECLARE
  t uuid;
  last_id uuid;
  batch uuid[];
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    last_id := NULL;
    LOOP
      PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
      PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
      SELECT pg_catalog.array_agg(s."id") INTO batch
        FROM (SELECT p."id" FROM public."payments" p
               WHERE p."tenantId" = t
                 AND (last_id IS NULL OR p."id" > last_id)
               ORDER BY p."id"
               LIMIT 2000) s;
      EXIT WHEN batch IS NULL;
      last_id := batch[pg_catalog.array_length(batch, 1)];
      INSERT INTO public."payment_base_retries" ("tenantId", "paymentId", "createdAt")
      SELECT p."tenantId", p."id", p."createdAt"
        FROM public."payments" p
        LEFT JOIN public."treatment_plans" tp
          ON tp."tenantId" = p."tenantId"
         AND tp."id" = p."treatmentPlanId"
         AND tp."deletedAt" IS NULL
       WHERE p."tenantId" = t
         AND p."id" = ANY (batch)
         AND p."deletedAt" IS NULL
         AND (
               (p."exchangeRateFrom" IS NULL
                AND (p."exchangeRateCurrency" IS NULL
                     OR p."currency" <> p."exchangeRateCurrency"))
            OR (tp."id" IS NOT NULL
                AND NOT EXISTS (
                      SELECT 1 FROM public."payment_plan_amounts" b
                       WHERE b."tenantId" = p."tenantId"
                         AND b."paymentId" = p."id"))
             )
      ON CONFLICT DO NOTHING;
      COMMIT;
    END LOOP;
  END LOOP;
END
$$;
