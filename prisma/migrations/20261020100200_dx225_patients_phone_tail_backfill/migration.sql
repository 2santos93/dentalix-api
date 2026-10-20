-- DX-225: relleno de patients."phoneTail" por lotes, sin DDL (DB-029).
--
-- Una única sentencia (DO): `prisma migrate deploy` la ejecuta fuera de un
-- bloque de transacción, así que cada COMMIT cierra un lote de 2.000
-- pacientes. Ningún lote toma ACCESS EXCLUSIVE: solo los bloqueos de fila de
-- sus 2.000 pacientes, y solo hasta su COMMIT. Las escrituras nuevas ya
-- llegan con "phoneTail" (trigger de 20261020100100).
--
-- Sin NO FORCE: con un owner sin superusuario ni BYPASSRLS (DX-113) la RLS
-- le aplica, así que el relleno recorre las clínicas y fija
-- `app.current_tenant` en cada lote (vuelve a fijarse tras cada COMMIT,
-- porque set_config(..., true) dura lo que la transacción). Con un owner
-- superusuario la RLS no le aplica y el resultado es el mismo.
--
-- Idempotente: solo toca filas con teléfono y sin "phoneTail". Si se corta a
-- mitad (los lotes hechos quedan), basta con repetirla
-- (`prisma migrate resolve --rolled-back` y `deploy`).
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
      -- Recorrido por (tenantId, id) con patients_tenant_id_key.
      SELECT pg_catalog.array_agg(s."id") INTO batch
        FROM (SELECT p."id" FROM public."patients" p
               WHERE p."tenantId" = t
                 AND (last_id IS NULL OR p."id" > last_id)
               ORDER BY p."id"
               LIMIT 2000) s;
      EXIT WHEN batch IS NULL;
      last_id := batch[pg_catalog.array_length(batch, 1)];
      -- El trigger recalcula el valor (UPDATE OF "phoneTail").
      UPDATE public."patients" p
         SET "phoneTail" = public.dx_phone_tail(p."phone")
       WHERE p."tenantId" = t
         AND p."id" = ANY (batch)
         AND p."phone" IS NOT NULL
         AND p."phoneTail" IS NULL;
      COMMIT;
    END LOOP;
  END LOOP;
END
$$;
