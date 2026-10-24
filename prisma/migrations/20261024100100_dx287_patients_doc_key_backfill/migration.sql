-- DX-287: relleno de patients."docKey" por lotes, sin DDL (DB-029, DB-048).
--
-- Una única sentencia (DO): `prisma migrate deploy` la ejecuta fuera de un
-- bloque de transacción, así que cada COMMIT cierra un lote de 2.000
-- pacientes. Ningún lote toma ACCESS EXCLUSIVE: solo los bloqueos de fila de
-- sus pacientes, y solo hasta su COMMIT. Las escrituras nuevas ya llegan con
-- "docKey" (trigger de 20261024100000). El índice todavía no existe, así que
-- el UPDATE no lo mantiene (y puede ser HOT).
--
-- Recorrido por cursor (tenantId, id > último) con patients_tenant_id_key, no
-- con ORDER BY … LIMIT sobre lo pendiente: cada lote cuesta lo mismo y el
-- total es lineal (DB-048).
--
-- Sin NO FORCE: con un owner sin superusuario ni BYPASSRLS (DX-113) la RLS
-- le aplica, así que recorre las clínicas y fija `app.current_tenant` en cada
-- lote (vuelve a fijarse tras cada COMMIT: set_config(..., true) dura lo que
-- la transacción). Con un owner superusuario el resultado es el mismo.
--
-- El UPDATE dispara patient_ledgers_patients_update, que solo actúa si cambia
-- "deletedAt": aquí no hace nada.
--
-- Idempotente: solo toca filas con documento y sin "docKey". Si se corta a
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
      SELECT pg_catalog.array_agg(s."id") INTO batch
        FROM (SELECT p."id" FROM public."patients" p
               WHERE p."tenantId" = t
                 AND (last_id IS NULL OR p."id" > last_id)
               ORDER BY p."id"
               LIMIT 2000) s;
      EXIT WHEN batch IS NULL;
      last_id := batch[pg_catalog.array_length(batch, 1)];
      -- El trigger recalcula el valor (UPDATE OF "docKey").
      UPDATE public."patients" p
         SET "docKey" = public.dx_doc_key(p."docNumber")
       WHERE p."tenantId" = t
         AND p."id" = ANY (batch)
         AND p."docNumber" IS NOT NULL
         AND p."docKey" IS NULL;
      COMMIT;
    END LOOP;
  END LOOP;
END
$$;
