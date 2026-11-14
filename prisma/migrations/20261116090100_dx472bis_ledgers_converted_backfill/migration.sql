-- DX-472-bis: recalcula la cartera de los pacientes con algún abono vivo en
-- otra moneda que la de su plan, con el cuerpo de
-- 20261116090000_dx472bis_ledgers_converted_paid. Los demás no cambian de
-- cifra (sus posiciones 9 y 10 serían 0 y nada) y se ponen al día en su
-- próximo refresco. Molde de 20261102120100_dx375_payment_exchange_rate_backfill.
--
-- Una única sentencia (DO): `prisma migrate deploy` la ejecuta fuera de un
-- bloque de transacción, así que cada COMMIT cierra un lote de 500 pacientes.
-- Cada lote es un `patient_ledgers_refresh` normal: los mismos bloqueos de
-- fila (paciente y su fila de cartera, en orden) que cualquier escritura, solo
-- hasta su COMMIT, y nada de ACCESS EXCLUSIVE. Recorrido por cursor
-- (tenantId, patientId > último).
--
-- Sin NO FORCE: con un owner sin superusuario ni BYPASSRLS (DX-113) la RLS
-- le aplica, así que recorre las clínicas y fija `app.current_tenant` en cada
-- lote (vuelve a fijarse tras cada COMMIT). Con un owner superusuario el
-- resultado es el mismo.
--
-- Idempotente: recalcular es siempre el mismo resultado. Si se corta a mitad,
-- basta con repetirla (`prisma migrate resolve --rolled-back
-- 20261116090100_dx472bis_ledgers_converted_backfill` y `deploy`); hasta
-- entonces la API lee las filas viejas como antes, sin convertir.
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
      SELECT pg_catalog.array_agg(s."patientId") INTO batch
        FROM (SELECT l."patientId" FROM public."patient_ledgers" l
               WHERE l."tenantId" = t
                 AND (last_id IS NULL OR l."patientId" > last_id)
               ORDER BY l."patientId"
               LIMIT 500) s;
      EXIT WHEN batch IS NULL;
      last_id := batch[pg_catalog.array_length(batch, 1)];
      SELECT pg_catalog.array_agg(DISTINCT p."patientId") INTO batch
        FROM public."payments" p
        JOIN public."treatment_plans" tp
          ON tp."tenantId" = p."tenantId" AND tp."id" = p."treatmentPlanId"
       WHERE p."tenantId" = t
         AND p."patientId" = ANY (batch)
         AND p."deletedAt" IS NULL
         AND p."currency" <> tp."currency";
      IF batch IS NOT NULL THEN
        PERFORM public."patient_ledgers_refresh"(
          pg_catalog.array_fill(t, ARRAY[pg_catalog.cardinality(batch)]), batch);
      END IF;
      COMMIT;
    END LOOP;
  END LOOP;
END
$$;
