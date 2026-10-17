-- DX-145 · siembra financiera del benchmark de la cartera (NO es parte de la
-- suite; ver docs/perf/DX-145.md). Corre como owner, en una base DESECHABLE ya
-- sembrada con dx043-seed.sql (60k pacientes y 350k citas). Determinista.
--   Tenant A: 70 % de los 50.000 pacientes con un plan de 2 ítems (ACCEPTED o
--             DONE); un tercio pagado entero, un tercio a medias y un tercio
--             sin abonos; 1 de cada 10 planes con un plan de 6 cuotas
--             mensuales. Las citas pasadas pasan a COMPLETED (atendidas), así
--             que cada paciente tiene «sede de la deuda».
--   Tenant B: lo mismo con sus 10.000 pacientes (ruido y aislamiento).
-- DX-155: es una carga masiva en UNA transacción. Los triggers que mantienen
-- patient_ledgers recalcularían decenas de miles de pacientes por sentencia
-- con las estadísticas de tablas que, para el planificador, siguen vacías (y
-- elegiría recorrer la clínica entera por paciente). Se pausan durante la
-- carga y el resumen se recalcula UNA vez al final, tras ANALYZE, como el
-- backfill de la migración (20261017233000_dx155_patient_ledgers).
\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tgrelid::regclass AS rel, tgname FROM pg_trigger
            WHERE tgname LIKE 'patient\_ledgers\_%' AND tgname <> 'patient_ledgers_guard'
  LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER %I', r.rel, r.tgname);
  END LOOP;
END;
$$;

UPDATE appointments SET status = 'COMPLETED'
 WHERE status = 'SCHEDULED' AND start < timestamp '2026-10-16';

INSERT INTO dental_catalog_items (id, "tenantId", code, kind, "labelEs", color, "updatedAt")
SELECT md5('cat:' || t)::uuid, t::uuid, 'BENCH', 'PROCEDURE', 'Resina', '#2A2B3C', now()
  FROM (VALUES ('00000000-0000-4000-a000-00000000000a'),
               ('00000000-0000-4000-a000-00000000000b')) AS v(t);

CREATE TEMP TABLE bench_plans ON COMMIT DROP AS
SELECT t.tenant_id, n,
       md5(t.tenant_id::text || ':' || n)::uuid AS patient_id,
       md5('plan:' || t.tenant_id::text || ':' || n)::uuid AS plan_id,
       (100000 + (n % 7) * 10000)::numeric AS price
  FROM (VALUES ('00000000-0000-4000-a000-00000000000a'::uuid, 50000),
               ('00000000-0000-4000-a000-00000000000b'::uuid, 10000)) AS t(tenant_id, total),
       generate_series(0, t.total - 1) AS n
 WHERE n % 10 < 7;

INSERT INTO treatment_plans (id, "tenantId", "patientId", status, currency,
                             "createdAt", "updatedAt")
SELECT plan_id, tenant_id, patient_id,
       (CASE WHEN n % 5 = 0 THEN 'COMPLETED' ELSE 'ACCEPTED' END)::"TreatmentPlanStatus",
       'COP',
       timestamp '2026-01-01' + (n % 280) * interval '1 day',
       now()
  FROM bench_plans;

INSERT INTO treatment_plan_items (id, "tenantId", "planId", "toothNumber",
                                  "catalogItemId", price, status, "updatedAt")
SELECT md5('item:' || plan_id::text || ':' || k)::uuid, tenant_id, plan_id,
       (11 + k)::text, md5('cat:' || tenant_id::text)::uuid, price,
       (CASE WHEN k = 0 THEN 'DONE' ELSE 'ACCEPTED' END)::"TreatmentPlanItemStatus",
       now()
  FROM bench_plans, generate_series(0, 1) AS k;

-- Abonos: n % 3 = 0 pagado entero (2 ítems), = 1 la mitad, = 2 nada.
INSERT INTO payments (id, "tenantId", "locationId", "treatmentPlanId", "patientId",
                      amount, currency, "paidAt", method, "updatedAt")
SELECT md5('pay:' || plan_id::text)::uuid, tenant_id,
       CASE WHEN tenant_id = '00000000-0000-4000-a000-00000000000b'
            THEN '00000000-0000-4000-b000-0000000000b1'::uuid
            WHEN n % 2 = 0 THEN '00000000-0000-4000-b000-0000000000a1'::uuid
            ELSE '00000000-0000-4000-b000-0000000000a2'::uuid END,
       plan_id, patient_id,
       CASE WHEN n % 3 = 0 THEN price * 2 ELSE price END,
       'COP',
       timestamp '2026-02-01 17:00' + (n % 250) * interval '1 day',
       'CASH', now()
  FROM bench_plans
 WHERE n % 3 < 2;

-- Planes de pago: 1 de cada 10 planes, 6 cuotas mensuales por lo que falta.
INSERT INTO payment_plans (id, "tenantId", "treatmentPlanId", "patientId", currency,
                           "totalToFinance", "installmentsCount", periodicity,
                           "startDate", "updatedAt")
SELECT md5('pp:' || plan_id::text)::uuid, tenant_id, plan_id, patient_id, 'COP',
       price, 6, 'MONTHLY',
       timestamp '2026-05-01' + (n % 120) * interval '1 day', now()
  FROM bench_plans
 WHERE n % 10 = 1;

INSERT INTO installments (id, "tenantId", "paymentPlanId", sequence, "dueDate",
                          amount, "updatedAt")
SELECT md5('inst:' || plan_id::text || ':' || s)::uuid, tenant_id,
       md5('pp:' || plan_id::text)::uuid, s,
       timestamp '2026-05-01' + (n % 120) * interval '1 day' + (s - 1) * interval '1 month',
       round(price / 6, 2), now()
  FROM bench_plans, generate_series(1, 6) AS s
 WHERE n % 10 = 1;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tgrelid::regclass AS rel, tgname FROM pg_trigger
            WHERE tgname LIKE 'patient\_ledgers\_%' AND tgname <> 'patient_ledgers_guard'
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE TRIGGER %I', r.rel, r.tgname);
  END LOOP;
END;
$$;
ANALYZE appointments, treatment_plans, treatment_plan_items, payments,
        payment_plans, installments, patients;
SELECT patient_ledgers_refresh(array_agg("tenantId"), array_agg("id")) FROM patients;

COMMIT;
VACUUM ANALYZE patient_ledgers;
VACUUM ANALYZE appointments;
VACUUM ANALYZE treatment_plans;
VACUUM ANALYZE treatment_plan_items;
VACUUM ANALYZE payments;
VACUUM ANALYZE payment_plans;
VACUUM ANALYZE installments;
