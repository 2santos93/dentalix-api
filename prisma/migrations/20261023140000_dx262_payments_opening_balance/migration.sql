-- DX-262 (revisión 2026-10-23, C1): un abono puede registrarse contra el
-- saldo migrado del paciente.
--
-- Cambios:
--   payments."treatmentPlanId" pasa a NULL admitido y se añade
--                       "openingBalanceId" (NULL). CHECK payments_target_check:
--                       exactamente uno de los dos (NOT VALID aquí: no lee
--                       filas; se valida en 20261023140200, que solo toma
--                       SHARE UPDATE EXCLUSIVE). Las FK compuestas existentes
--                       son MATCH SIMPLE: con "treatmentPlanId" NULL la del
--                       plan no se comprueba.
--   payments_opening_balance_fkey  ("tenantId", "openingBalanceId",
--                       "patientId") → opening_balances(tenantId, id,
--                       patientId): el saldo es de la MISMA clínica y del MISMO
--                       paciente que el abono. NOT VALID (no lee filas; la
--                       columna nace entera a NULL); el índice parcial va
--                       CONCURRENTLY en 20261023140100 y la validación en
--                       20261023140300 (patrón de DX-107, I3).
--   opening_balances_tenant_id_patient_key  único que pide esa FK (tabla de
--                       DX-262, pequeña).
--   patient_ledgers_compute  el saldo migrado lleva lo abonado vivo en su
--                       moneda ("openings": [[id, moneda, importe, fecha,
--                       aproximada, abonado], ...]) y solo debe si queda
--                       pendiente.
--   patient_ledgers_on_payments  también refresca si cambia "openingBalanceId".
--   patient_import_batches  "balanceUndoneTotals" (lo que retiró de verdad el
--                       deshacer, para la auditoría) y "balanceAmbiguousCount"
--                       (saldos no creados por documento ambiguo).
--
-- Sin bloqueo largo: DROP NOT NULL, ADD COLUMN sin DEFAULT y ADD CONSTRAINT
-- NOT VALID solo tocan el catálogo (ACCESS EXCLUSIVE sobre payments el
-- instante del COMMIT, acotado por lock_timeout). No lee filas de tablas con
-- FORCE ni quita FORCE. Compatible hacia atrás: el código anterior siempre
-- escribe "treatmentPlanId" (cumple el CHECK) y no lee las columnas nuevas.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "payments" ALTER COLUMN "treatmentPlanId" DROP NOT NULL;
ALTER TABLE "payments" ADD COLUMN "openingBalanceId" UUID;
ALTER TABLE "payments" ADD CONSTRAINT "payments_target_check"
  CHECK (num_nonnulls("treatmentPlanId", "openingBalanceId") = 1) NOT VALID;

CREATE UNIQUE INDEX "opening_balances_tenant_id_patient_key"
  ON "opening_balances"("tenantId", "id", "patientId");

ALTER TABLE "payments" ADD CONSTRAINT "payments_opening_balance_fkey"
  FOREIGN KEY ("tenantId", "openingBalanceId", "patientId")
  REFERENCES "opening_balances"("tenantId", "id", "patientId")
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "patient_import_batches"
  ADD COLUMN "balanceUndoneTotals" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "balanceAmbiguousCount" INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Resumen de la cartera: el saldo migrado menos lo abonado a él
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public."patient_ledgers_compute"()
  RETURNS TABLE (
    "tenantId"   uuid,
    "patientId"  uuid,
    "locationId" uuid,
    "owing"      boolean,
    "ledger"     jsonb
  )
  LANGUAGE sql
  STABLE
AS $$
  SELECT pa."tenantId", pa."id",
         COALESCE(visit."locationId", paid."locationId", presented."locationId", ob."locationId"),
         pa."deletedAt" IS NULL AND (COALESCE(pl."owing", false) OR COALESCE(ob."owing", false)),
         pg_catalog.jsonb_build_object(
           'plans', COALESCE(pl."plans", '[]'::jsonb),
           'paymentPlans', COALESCE(sched."paymentPlans", '[]'::jsonb),
           'openings', COALESCE(ob."openings", '[]'::jsonb))
    FROM public."patients" pa
    -- Sede de la deuda: última cita atendida (índice parcial de DX-145) …
    LEFT JOIN LATERAL (
      SELECT a."locationId"
        FROM public."appointments" a
       WHERE a."tenantId" = pa."tenantId"
         AND a."patientId" = pa."id"
         AND a."status" = 'COMPLETED'
         AND a."deletedAt" IS NULL
       ORDER BY a."start" DESC, a."id" DESC
       LIMIT 1
    ) visit ON true
    -- … o último abono vivo …
    LEFT JOIN LATERAL (
      SELECT p."locationId"
        FROM public."payments" p
       WHERE p."tenantId" = pa."tenantId"
         AND p."patientId" = pa."id"
         AND p."deletedAt" IS NULL
       ORDER BY p."paidAt" DESC, p."id" DESC
       LIMIT 1
    ) paid ON true
    -- … o última presentación de un plan vivo …
    LEFT JOIN LATERAL (
      SELECT tp."presentedLocationId" AS "locationId"
        FROM public."treatment_plans" tp
       WHERE tp."tenantId" = pa."tenantId"
         AND tp."patientId" = pa."id"
         AND tp."deletedAt" IS NULL
         AND tp."presentedLocationId" IS NOT NULL
       ORDER BY tp."presentedAt" DESC NULLS LAST, tp."id" DESC
       LIMIT 1
    ) presented ON true
    -- … o la del último saldo migrado vivo (DX-262), con lo abonado a él.
    LEFT JOIN LATERAL (
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
               o."id", o."currency", o."amount",
               pg_catalog.to_char(o."asOfDate", 'YYYY-MM-DD'), o."asOfDateApproximate",
               COALESCE(op."paid", 0))
               ORDER BY o."asOfDate", o."id") AS "openings",
             pg_catalog.bool_or(o."amount" > COALESCE(op."paid", 0)) AS "owing",
             (pg_catalog.array_agg(o."locationId" ORDER BY o."createdAt" DESC, o."id" DESC))[1]
               AS "locationId"
        FROM public."opening_balances" o
        -- Abonos vivos contra el saldo, en su moneda (la API no admite otra).
        LEFT JOIN LATERAL (
          SELECT pg_catalog.sum(p."amount") AS "paid"
            FROM public."payments" p
           WHERE p."tenantId" = o."tenantId"
             AND p."openingBalanceId" = o."id"
             AND p."currency" = o."currency"
             AND p."deletedAt" IS NULL
        ) op ON true
       WHERE o."tenantId" = pa."tenantId"
         AND o."patientId" = pa."id"
         AND o."voidedAt" IS NULL
    ) ob ON true
    -- Planes vivos con sus sumas.
    LEFT JOIN LATERAL (
      SELECT pg_catalog.bool_or(s."billable" > s."paidOwn") AS "owing",
             pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
               s."id", s."status", s."currency", s."createdMs", s."agingFromMs",
               s."billable", NULLIF(s."paidOwn", 0), s."paidOther")
               ORDER BY s."id") AS "plans"
        FROM (
          SELECT tp."id", tp."status", tp."currency",
                 (EXTRACT(EPOCH FROM tp."createdAt") * 1000)::float8 AS "createdMs",
                 (EXTRACT(EPOCH FROM COALESCE(acc."acceptedAt", tp."presentedAt", tp."createdAt")) * 1000)::float8
                   AS "agingFromMs",
                 COALESCE(items."billable", 0) AS "billable",
                 COALESCE(pays."own", 0) AS "paidOwn",
                 pays."other" AS "paidOther"
            FROM public."treatment_plans" tp
            LEFT JOIN public."treatment_plan_acceptances" acc
              ON acc."tenantId" = tp."tenantId" AND acc."planId" = tp."id"
            LEFT JOIN LATERAL (
              SELECT pg_catalog.sum(i."price") - pg_catalog.sum(i."discount") AS "billable"
                FROM public."treatment_plan_items" i
               WHERE i."tenantId" = tp."tenantId"
                 AND i."planId" = tp."id"
                 AND i."deletedAt" IS NULL
                 AND i."status" IN ('ACCEPTED', 'DONE')
            ) items ON true
            LEFT JOIN LATERAL (
              SELECT pg_catalog.sum(c."amount") FILTER (WHERE c."currency" = tp."currency") AS "own",
                     pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(c."currency", c."amount")
                       ORDER BY c."currency") FILTER (WHERE c."currency" <> tp."currency") AS "other"
                FROM (SELECT p."currency", pg_catalog.sum(p."amount") AS "amount"
                        FROM public."payments" p
                       WHERE p."tenantId" = tp."tenantId"
                         AND p."treatmentPlanId" = tp."id"
                         AND p."deletedAt" IS NULL
                       GROUP BY p."currency") c
            ) pays ON true
           WHERE tp."tenantId" = pa."tenantId"
             AND tp."patientId" = pa."id"
             AND tp."deletedAt" IS NULL
        ) s
    ) pl ON true
    -- Planes de cuotas vivos, no cancelados, de planes vivos, con sus cuotas.
    LEFT JOIN LATERAL (
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
               pp."id", pp."treatmentPlanId", pp."currency", pp."status",
               pp."downPayment",
               (EXTRACT(EPOCH FROM pp."startDate") * 1000)::float8,
               COALESCE((
                 SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
                          i."sequence",
                          (EXTRACT(EPOCH FROM i."dueDate") * 1000)::float8,
                          i."amount") ORDER BY i."sequence")
                   FROM public."installments" i
                  WHERE i."tenantId" = pp."tenantId"
                    AND i."paymentPlanId" = pp."id"
               ), '[]'::jsonb))
               ORDER BY pp."id") AS "paymentPlans"
        FROM public."payment_plans" pp
        JOIN public."treatment_plans" tp
          ON tp."tenantId" = pp."tenantId" AND tp."id" = pp."treatmentPlanId"
       WHERE pp."tenantId" = pa."tenantId"
         AND pp."patientId" = pa."id"
         AND pp."deletedAt" IS NULL
         AND pp."status" <> 'CANCELLED'
         AND tp."deletedAt" IS NULL
    ) sched ON true
$$;


-- Mismo cuerpo que en 20261017233000_dx155_patient_ledgers, con
-- "openingBalanceId" entre las columnas que cuentan.
CREATE OR REPLACE FUNCTION public."patient_ledgers_on_payments"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ts uuid[];
  ps uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT pg_catalog.array_agg(n."tenantId"), pg_catalog.array_agg(n."patientId")
      INTO ts, ps FROM new_rows n;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT pg_catalog.array_agg(o."tenantId"), pg_catalog.array_agg(o."patientId")
      INTO ts, ps FROM old_rows o;
  ELSE
    SELECT pg_catalog.array_agg(k.t), pg_catalog.array_agg(k.p)
      INTO ts, ps
      FROM new_rows n JOIN old_rows o ON o."id" = n."id",
           LATERAL (VALUES (o."tenantId", o."patientId"), (n."tenantId", n."patientId")) AS k(t, p)
     WHERE (o."tenantId", o."patientId", o."treatmentPlanId", o."openingBalanceId", o."amount",
            o."currency", o."deletedAt", o."locationId", o."paidAt")
           IS DISTINCT FROM
           (n."tenantId", n."patientId", n."treatmentPlanId", n."openingBalanceId", n."amount",
            n."currency", n."deletedAt", n."locationId", n."paidAt");
  END IF;
  PERFORM public."patient_ledgers_refresh"(ts, ps);
  RETURN NULL;
END;
$$;
