-- DX-375: relleno de "exchangeRateCurrency" en los abonos anteriores cuya
-- moneda es la de su destino (el plan o el saldo migrado), que son casi todos:
-- no necesitan tasa y quedan como cualquier abono nuevo en su moneda. Por
-- lotes, sin DDL. Molde de 20261030120100_dx327_document_type_backfill.
--
-- Los abonos en otra moneda que su destino NO se tocan aquí: la tasa de su
-- día depende de la fuente de la clínica, de la zona de su sede y del
-- proveedor, y esa lógica vive solo en la API. Con "exchangeRateCurrency" NULL
-- la API los lee como antes (con la tasa de su día, «lectura compatible») y
-- el barrido de cada minuto (`payment-allocations.sweep`) les congela esa
-- misma tasa, hasta 50 por clínica y pasada: el saldo no cambia.
--
-- Una única sentencia (DO): `prisma migrate deploy` la ejecuta fuera de un
-- bloque de transacción, así que cada COMMIT cierra un lote de 2.000 filas.
-- Ningún lote toma ACCESS EXCLUSIVE: solo los bloqueos de fila de su lote, y
-- solo hasta su COMMIT. Recorrido por cursor (tenantId, id > último).
--
-- Sin NO FORCE: con un owner sin superusuario ni BYPASSRLS (DX-113) la RLS
-- le aplica, así que recorre las clínicas y fija `app.current_tenant` en cada
-- lote (vuelve a fijarse tras cada COMMIT). Con un owner superusuario el
-- resultado es el mismo.
--
-- "updatedAt" no cambia. El trigger de saldos del paciente
-- (patient_ledgers_payments_update) no mira la columna: no recalcula nada.
-- Incluye los abonos anulados (no cambia nada de ellos).
--
-- Idempotente: solo toca filas con la columna NULL. Si se corta a mitad, basta
-- con repetirla (`prisma migrate resolve --rolled-back
-- 20261102120100_dx375_payment_exchange_rate_backfill` y `deploy`).
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
      UPDATE public."payments" p
         SET "exchangeRateCurrency" = p."currency"
       WHERE p."tenantId" = t
         AND p."id" = ANY (batch)
         AND p."exchangeRateCurrency" IS NULL
         AND p."currency" = COALESCE(
               (SELECT tp."currency" FROM public."treatment_plans" tp
                 WHERE tp."tenantId" = p."tenantId"
                   AND tp."id" = p."treatmentPlanId"),
               (SELECT o."currency" FROM public."opening_balances" o
                 WHERE o."tenantId" = p."tenantId"
                   AND o."id" = p."openingBalanceId"));
      COMMIT;
    END LOOP;
  END LOOP;
END
$$;
