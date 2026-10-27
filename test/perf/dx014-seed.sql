-- DX-014 · siembra del benchmark de «Comparar sedes» (NO es parte de la suite;
-- ver docs/perf/DX-014.md). Corre como owner en una base DESECHABLE ya migrada
-- (con la siembra de referencia: monedas). Determinista: sin random().
--   Tenant "bench-reportes": 5 sedes con horario (lun-vie 9-13 y 15-19, sáb
--   9-13, Bogotá), 20 profesionales, 20.000 pacientes y 24 MESES de actividad
--   (2024-10-25 → 2026-10-24) para poder comparar 12 meses con los 12
--   anteriores: 24 citas por sede y día abierto (~75.000; 85 % atendidas, 7 %
--   no-show, el resto canceladas), un ítem realizado (COP; 1 de cada 10 en USD)
--   y un abono por cada dos citas atendidas, y cierres de sede de un día al mes.
\set ON_ERROR_STOP on
BEGIN;

-- Carga masiva: se pausan los triggers del resumen patient_ledgers (como
-- dx145-seed.sql); el reporte no lo lee y la base es desechable.
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

INSERT INTO tenants (id, name, subdomain, "updatedAt") VALUES
  ('00000000-0000-4000-a000-0000000000d1', 'Bench reportes', 'bench-reportes', now());

-- G1: dato de bench (REGIONAL_BOGOTA_FIXTURE), no un default del producto.
INSERT INTO locations (id, "tenantId", name, country, currency, "timeZone", locale, "createdAt", "updatedAt")
SELECT ('00000000-0000-4000-b000-0000000000d' || s)::uuid,
       '00000000-0000-4000-a000-0000000000d1', 'Sede ' || s,
       'CO', 'COP', 'America/Bogota', 'es-CO',
       timestamp '2024-01-01' + s * interval '1 minute', now()
  FROM generate_series(1, 5) AS s;

INSERT INTO location_schedules (id, "tenantId", "locationId", timezone, "updatedAt")
SELECT md5('sched:' || s)::uuid, '00000000-0000-4000-a000-0000000000d1',
       ('00000000-0000-4000-b000-0000000000d' || s)::uuid, 'America/Bogota', now()
  FROM generate_series(1, 5) AS s;

INSERT INTO location_schedule_ranges (id, "tenantId", "scheduleId", weekday, "startMinute", "endMinute")
SELECT md5('range:' || s || ':' || w || ':' || r)::uuid,
       '00000000-0000-4000-a000-0000000000d1', md5('sched:' || s)::uuid, w,
       CASE r WHEN 0 THEN 540 ELSE 900 END, CASE r WHEN 0 THEN 780 ELSE 1140 END
  FROM generate_series(1, 5) AS s, generate_series(1, 6) AS w, generate_series(0, 1) AS r
 WHERE w < 6 OR r = 0;

INSERT INTO users (id, email, "passwordHash", "fullName", "updatedAt")
SELECT md5('bench-user:' || p)::uuid, 'bench-reportes-' || p || '@example.com', 'x',
       'Profesional ' || p, now()
  FROM generate_series(0, 19) AS p;
INSERT INTO clinic_memberships (id, "tenantId", "userId", role, "updatedAt")
SELECT md5('bench-member:' || p)::uuid, '00000000-0000-4000-a000-0000000000d1',
       md5('bench-user:' || p)::uuid, 'DENTIST', now()
  FROM generate_series(0, 19) AS p;

INSERT INTO patients (id, "tenantId", "firstName", "lastName", "docNumber", "updatedAt")
SELECT md5('bench-patient:' || n)::uuid, '00000000-0000-4000-a000-0000000000d1',
       'Paciente', 'Bench ' || n, (2000000000 + n)::text, now()
  FROM generate_series(0, 19999) AS n;

INSERT INTO dental_catalog_items (id, "tenantId", code, kind, "labelEs", color, "updatedAt")
VALUES (md5('bench-cat')::uuid, '00000000-0000-4000-a000-0000000000d1', 'BENCH',
        'PROCEDURE', 'Resina', '#2A2B3C', now());

-- Cada sede: 4 profesionales propios, 6 citas de 30 min por profesional y día
-- (9:00-12:00 Bogotá = 14:00-17:00 UTC). Lunes a sábado.
CREATE TEMP TABLE bench_appts ON COMMIT DROP AS
SELECT row_number() OVER () AS n, s, d, p, k,
       timestamp '2024-10-25 14:00' + d * interval '1 day' + k * interval '30 minutes' AS start
  FROM generate_series(1, 5) AS s,
       generate_series(0, 729) AS d,
       generate_series(0, 3) AS p,
       generate_series(0, 5) AS k
 WHERE extract(dow FROM date '2024-10-25' + d) <> 0;

-- Los pacientes rotan en bloques de 120 citas consecutivas (una sede y un
-- día), así nunca coinciden a la misma hora.
INSERT INTO appointments (id, "tenantId", "patientId", "providerId", "locationId",
                          start, "end", status, "updatedAt")
SELECT md5('bench-appt:' || n)::uuid, '00000000-0000-4000-a000-0000000000d1',
       md5('bench-patient:' || (n % 20000))::uuid,
       md5('bench-user:' || ((s - 1) * 4 + p))::uuid,
       ('00000000-0000-4000-b000-0000000000d' || s)::uuid,
       start, start + interval '30 minutes',
       (CASE WHEN n % 100 < 85 THEN 'COMPLETED'
             WHEN n % 100 < 92 THEN 'NO_SHOW'
             ELSE 'CANCELLED' END)::"AppointmentStatus",
       now()
  FROM bench_appts;

INSERT INTO treatment_plans (id, "tenantId", "patientId", status, currency, "updatedAt")
SELECT md5('bench-plan:' || n)::uuid, '00000000-0000-4000-a000-0000000000d1',
       md5('bench-patient:' || (n % 20000))::uuid, 'ACCEPTED',
       CASE WHEN n % 10 = 0 THEN 'USD' ELSE 'COP' END, now()
  FROM bench_appts WHERE n % 100 < 85 AND n % 2 = 0;

INSERT INTO treatment_plan_items (id, "tenantId", "planId", "toothNumber", "catalogItemId",
                                  price, discount, status, "performedById",
                                  "performedByMembershipId", "performedLocationId",
                                  "completedAt", "updatedAt")
SELECT md5('bench-item:' || n)::uuid, '00000000-0000-4000-a000-0000000000d1',
       md5('bench-plan:' || n)::uuid, '16', md5('bench-cat')::uuid,
       CASE WHEN n % 10 = 0 THEN 150 ELSE 150000 END, 0, 'DONE',
       md5('bench-user:' || ((s - 1) * 4 + p))::uuid,
       md5('bench-member:' || ((s - 1) * 4 + p))::uuid,
       ('00000000-0000-4000-b000-0000000000d' || s)::uuid,
       start + interval '20 minutes', now()
  FROM bench_appts WHERE n % 100 < 85 AND n % 2 = 0;

INSERT INTO payments (id, "tenantId", "locationId", "treatmentPlanId", "patientId",
                      amount, currency, "paidAt", "updatedAt")
SELECT md5('bench-pay:' || n)::uuid, '00000000-0000-4000-a000-0000000000d1',
       ('00000000-0000-4000-b000-0000000000d' || s)::uuid,
       md5('bench-plan:' || n)::uuid, md5('bench-patient:' || (n % 20000))::uuid,
       CASE WHEN n % 10 = 0 THEN 100 ELSE 120000 END,
       CASE WHEN n % 10 = 0 THEN 'USD' ELSE 'COP' END,
       start + interval '40 minutes', now()
  FROM bench_appts WHERE n % 100 < 85 AND n % 2 = 0;

INSERT INTO schedule_blocks (id, "tenantId", "locationId", start, "end", kind, "updatedAt")
SELECT md5('bench-block:' || s || ':' || m)::uuid, '00000000-0000-4000-a000-0000000000d1',
       ('00000000-0000-4000-b000-0000000000d' || s)::uuid,
       timestamp '2024-11-03 05:00' + m * interval '1 month',
       timestamp '2024-11-04 05:00' + m * interval '1 month', 'OTHER', now()
  FROM generate_series(1, 5) AS s, generate_series(0, 23) AS m;

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

COMMIT;
ANALYZE appointments;
ANALYZE treatment_plan_items;
ANALYZE treatment_plans;
ANALYZE payments;
ANALYZE schedule_blocks;
