-- DX-472-bis: la cartera (`patient_ledgers`) cuenta lo abonado en otra moneda
-- convertido, como el estado de cuenta desde DX-472.
--
-- Ejemplo: plan de USD 100 con un abono de Bs 3.600 a tasa 36. El estado de
-- cuenta dice saldo 0; la cartera decía USD 100 por cobrar y Bs 3.600 a
-- favor, y el chip «Saldo vencido» salía si había cuotas pasadas.
--
-- Decisión (REPORT-DX-472-bis): la tabla precalculada no llama al proveedor
-- de tasas. Guarda, por plan, lo que ya está en la moneda del plan:
--   * `paidBased` (posición 9): Σ de las bases (DX-051) de los abonos en otra
--     moneda. La base es el abono convertido UNA vez con su tasa congelada
--     (DX-375) y no cambia: es la misma cifra que suma `/balance`.
--   * `pending` (posición 10): los abonos en otra moneda aún sin base, uno a
--     uno, con su tasa congelada si la tienen. La API los convierte con la
--     MISMA cuenta que el saldo del plan (`PlanBalanceCalculator`): con tasa
--     congelada, sin red; «sin tasa», sin sumar; anteriores a DX-375 sin
--     congelar, con la tasa de su día y el plazo único de DX-472. Es una lista
--     corta y pasajera: el barrido de DX-380 congela y crea la base en minutos.
-- `owing` pasa a ser «facturable > abonado en su moneda + bases»: sigue
-- siendo un superconjunto exacto de quien tiene deuda (lo de `pending` solo
-- puede bajar el saldo).
--
-- Para que el resumen siga al día:
--   * `patient_ledgers_on_payments` también recalcula cuando cambia la tasa
--     congelada (el barrido la congela con un UPDATE);
--   * nuevo trigger por sentencia en `payment_plan_amounts` (INSERT y DELETE;
--     su UPDATE solo cambia `manual`, que la cartera no mira).
-- Orden de bloqueo del alta de una base (`createBase`): abono FOR SHARE y
-- luego el paciente en el refresco, el mismo orden que la anulación (abono y
-- luego paciente): no añade un ciclo.
--
-- Compatible hacia atrás:
--   * Solo `CREATE OR REPLACE` y un trigger nuevo; sin columnas ni tablas.
--   * Las tuplas de plan crecen por el final: una réplica anterior lee las 8
--     primeras como siempre (y sigue sin convertir); la nueva lee una fila
--     aún sin las posiciones 9 y 10 como antes (sin convertir).
--   * Las filas ya escritas se recalculan en la migración siguiente
--     (20261116090100_dx472bis_ledgers_converted_backfill), por lotes.
--
-- `patient_ledgers_refresh` no cambia (es la de DX-294-ter): el cálculo sigue
-- siendo una subconsulta correlacionada por clave primaria, y este LATERAL
-- nuevo usa los mismos índices que el de abonos de al lado (payments por
-- plan) y la clave primaria de `payment_plan_amounts`. Un paciente sin planes
-- (los 10.000 importados del deshacer de DX-294) no lo ejecuta.
--
-- Vuelta atrás: volver a aplicar `patient_ledgers_compute` de
-- 20261106130002_dx253_patient_credit, `patient_ledgers_on_payments` de
-- 20261023140000_dx262_payments_opening_balance, y
-- DROP TRIGGER "patient_ledgers_plan_amounts_insert" / "_delete" ON
-- "payment_plan_amounts"; DROP FUNCTION "patient_ledgers_on_plan_amounts"().
-- Con el cuerpo viejo, las filas recalculadas vuelven a su forma de 8.

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
      -- DX-472-bis: lo abonado en otra moneda con base cuenta como abonado
      -- del plan (la base es su importe en la moneda del plan, inmutable);
      -- el plan solo «debe» si no lo cubre. Superconjunto exacto del saldo
      -- de la API, que suma además lo convertido de `pending`.
      SELECT pg_catalog.bool_or(s."billable" > s."paidOwn" + s."paidBased") AS "owing",
             pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
               s."id", s."status", s."currency", s."createdMs", s."agingFromMs",
               s."billable", NULLIF(s."paidOwn", 0), s."paidOther",
               s."paidBased", s."pending")
               ORDER BY s."id") AS "plans"
        FROM (
          SELECT tp."id", tp."status", tp."currency",
                 (EXTRACT(EPOCH FROM tp."createdAt") * 1000)::float8 AS "createdMs",
                 (EXTRACT(EPOCH FROM COALESCE(acc."acceptedAt", tp."presentedAt", tp."createdAt")) * 1000)::float8
                   AS "agingFromMs",
                 COALESCE(items."billable", 0) AS "billable",
                 COALESCE(pays."own", 0) + COALESCE(cred."net", 0) AS "paidOwn",
                 pays."other" AS "paidOther",
                 COALESCE(conv."based", 0) AS "paidBased",
                 conv."pending" AS "pending"
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
            -- DX-253: asientos del saldo a favor (traspasos y devoluciones), en
            -- la moneda del plan, con signo: cuentan como lo abonado.
            LEFT JOIN LATERAL (
              SELECT pg_catalog.sum(e."amount") AS "net"
                FROM public."patient_credit_entries" e
               WHERE e."tenantId" = tp."tenantId"
                 AND e."treatmentPlanId" = tp."id"
                 AND e."currency" = tp."currency"
            ) cred ON true
            -- DX-472-bis: los abonos vivos en otra moneda que la del plan.
            -- Con base (DX-051), su importe en la moneda del plan, sumado.
            -- Sin base, uno a uno con su tasa congelada (DX-375), si la hay,
            -- para que la API los convierta con la misma cuenta que el saldo:
            -- [id, moneda, importe, paidAt (epoch ms), sede, moneda de la
            -- tasa, tasa de origen, tasa de destino, fuente, día de la tasa].
            LEFT JOIN LATERAL (
              SELECT pg_catalog.sum(b."amount") AS "based",
                     pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
                       p."id", p."currency", p."amount",
                       (EXTRACT(EPOCH FROM p."paidAt") * 1000)::float8,
                       p."locationId", p."exchangeRateCurrency",
                       p."exchangeRateFrom", p."exchangeRateTo",
                       p."exchangeRateSource",
                       pg_catalog.to_char(p."exchangeRateDate", 'YYYY-MM-DD'))
                       ORDER BY p."paidAt", p."id")
                       FILTER (WHERE b."paymentId" IS NULL) AS "pending"
                FROM public."payments" p
                -- Solo una base en la moneda del plan (como el reparto de
                -- DX-051): otra no es una cifra en esta moneda.
                LEFT JOIN public."payment_plan_amounts" b
                  ON b."tenantId" = p."tenantId" AND b."paymentId" = p."id"
                 AND b."currency" = tp."currency"
               WHERE p."tenantId" = tp."tenantId"
                 AND p."treatmentPlanId" = tp."id"
                 AND p."currency" <> tp."currency"
                 AND p."deletedAt" IS NULL
            ) conv ON true
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

-- Mismo cuerpo que en 20261023140000_dx262_payments_opening_balance, con las
-- columnas de la tasa congelada (DX-375) entre las que cuentan.
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
            o."currency", o."deletedAt", o."locationId", o."paidAt",
            o."exchangeRateCurrency", o."exchangeRateFrom", o."exchangeRateTo",
            o."exchangeRateSource", o."exchangeRateDate")
           IS DISTINCT FROM
           (n."tenantId", n."patientId", n."treatmentPlanId", n."openingBalanceId", n."amount",
            n."currency", n."deletedAt", n."locationId", n."paidAt",
            n."exchangeRateCurrency", n."exchangeRateFrom", n."exchangeRateTo",
            n."exchangeRateSource", n."exchangeRateDate");
  END IF;
  PERFORM public."patient_ledgers_refresh"(ts, ps);
  RETURN NULL;
END;
$$;

-- DX-472-bis: una base nueva (o borrada por un superusuario) recalcula la
-- cartera del paciente de su abono.
CREATE FUNCTION public."patient_ledgers_on_plan_amounts"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ts uuid[];
  ps uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT pg_catalog.array_agg(p."tenantId"), pg_catalog.array_agg(p."patientId")
      INTO ts, ps
      FROM new_rows n
      JOIN public."payments" p ON p."tenantId" = n."tenantId" AND p."id" = n."paymentId";
  ELSE
    SELECT pg_catalog.array_agg(p."tenantId"), pg_catalog.array_agg(p."patientId")
      INTO ts, ps
      FROM old_rows o
      JOIN public."payments" p ON p."tenantId" = o."tenantId" AND p."id" = o."paymentId";
  END IF;
  PERFORM public."patient_ledgers_refresh"(ts, ps);
  RETURN NULL;
END;
$$;

CREATE TRIGGER "patient_ledgers_plan_amounts_insert"
  AFTER INSERT ON "payment_plan_amounts"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public."patient_ledgers_on_plan_amounts"();
CREATE TRIGGER "patient_ledgers_plan_amounts_delete"
  AFTER DELETE ON "payment_plan_amounts"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public."patient_ledgers_on_plan_amounts"();
