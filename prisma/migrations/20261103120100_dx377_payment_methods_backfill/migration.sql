-- DX-377: relleno de los medios de pago iniciales y enlace de los abonos.
--
-- Cada clínica recibe sus 4 medios iniciales, uno por método antiguo
-- (Efectivo, Tarjeta, Transferencia, Otro; activos y sin pedir referencia, así
-- la caja se comporta como hasta ahora), y cada abono con "method" se enlaza
-- al medio inicial de ese método. Los abonos sin método se quedan sin medio.
-- "method" no cambia. Las clínicas nuevas los reciben en el alta (API).
--
-- Una única sentencia (DO): `prisma migrate deploy` la ejecuta fuera de un
-- bloque de transacción, así que cada COMMIT cierra un lote de 2.000 abonos.
-- Ningún lote toma ACCESS EXCLUSIVE: solo los bloqueos de fila de su lote.
-- Recorrido por cursor (tenantId, id > último). Molde de 20261102120100.
--
-- Sin NO FORCE: con un owner sin superusuario ni BYPASSRLS (DX-113) la RLS le
-- aplica, así que recorre las clínicas y fija `app.current_tenant` en cada
-- lote (vuelve a fijarse tras cada COMMIT).
--
-- "updatedAt" de los abonos no cambia. El trigger de saldos del paciente no
-- mira la columna. Incluye los abonos anulados (conservan su medio).
--
-- Idempotente: los medios con ON CONFLICT (único parcial por método antiguo)
-- y los abonos solo con "paymentMethodId" NULL. Si se corta a mitad, basta con
-- repetirla (`prisma migrate resolve --rolled-back
-- 20261103120100_dx377_payment_methods_backfill` y `deploy`).
DO $$
DECLARE
  t uuid;
  last_id uuid;
  batch uuid[];
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
    PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
    INSERT INTO public."payment_methods"
      ("id", "tenantId", "name", "kind", "legacyMethod", "updatedAt")
    SELECT gen_random_uuid(), t, m.name, m.kind::public."PaymentMethodKind",
           m.legacy::public."PaymentMethod", CURRENT_TIMESTAMP
      FROM (VALUES ('Efectivo', 'CASH', 'CASH'),
                   ('Tarjeta', 'CARD', 'CARD'),
                   ('Transferencia', 'TRANSFER', 'TRANSFER'),
                   ('Otro', 'OTHER', 'OTHER')) AS m(name, kind, legacy)
    ON CONFLICT ("tenantId", "legacyMethod") WHERE "legacyMethod" IS NOT NULL
      DO NOTHING;
    COMMIT;

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
      UPDATE public."payments" p
         SET "paymentMethodId" = pm."id"
        FROM public."payment_methods" pm
       WHERE p."tenantId" = t
         AND p."id" = ANY (batch)
         AND p."paymentMethodId" IS NULL
         AND pm."tenantId" = p."tenantId"
         AND pm."legacyMethod" = p."method";
      COMMIT;
    END LOOP;
  END LOOP;
END
$$;
