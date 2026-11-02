-- DX-423 · siembra del benchmark de «Producción por procedimiento» (NO es parte
-- de la suite; ver docs/perf/DX-423.md). Corre como owner en una base
-- DESECHABLE ya migrada (con la siembra de referencia: monedas). Determinista.
--   Tenant "bench-produccion": 5 sedes, 20 profesionales, 20.000
--   pacientes, 60 procedimientos en 8 categorías y 24 MESES (2024-11-01 →
--   2026-10-31) con 200.000 ítems REALIZADOS (1 de cada 10 en USD, 1 de cada 5
--   con descuento, catálogo congelado), más 20.000 propuestos/aceptados, 2.000
--   borrados y 500 «Sin atribuir». Otro tenant con 50.000 realizados para que
--   la RLS tenga algo que descartar.
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

INSERT INTO tenants (id, name, subdomain, "updatedAt") VALUES
  ('00000000-0000-4000-a000-000000000423', 'Bench producción', 'bench-produccion', now()),
  ('00000000-0000-4000-a000-000000000424', 'Bench ruido', 'bench-ruido', now());

-- G1: dato de bench (REGIONAL_BOGOTA_FIXTURE), no un default del producto.
INSERT INTO locations (id, "tenantId", name, country, currency, "timeZone", locale, "createdAt", "updatedAt")
SELECT md5('dx423-loc:' || t || ':' || s)::uuid,
       ('00000000-0000-4000-a000-00000000042' || t)::uuid, 'Sede ' || s,
       'CO', 'COP', 'America/Bogota', 'es-CO',
       timestamp '2024-01-01' + s * interval '1 minute', now()
  FROM generate_series(3, 4) AS t, generate_series(1, 5) AS s;

INSERT INTO users (id, email, "passwordHash", "fullName", "updatedAt")
SELECT md5('dx423-user:' || t || ':' || p)::uuid,
       'bench-produccion-' || t || '-' || p || '@example.com', 'x',
       'Profesional ' || p, now()
  FROM generate_series(3, 4) AS t, generate_series(0, 19) AS p;
INSERT INTO clinic_memberships (id, "tenantId", "userId", role, "updatedAt")
SELECT md5('dx423-member:' || t || ':' || p)::uuid,
       ('00000000-0000-4000-a000-00000000042' || t)::uuid,
       md5('dx423-user:' || t || ':' || p)::uuid, 'DENTIST', now()
  FROM generate_series(3, 4) AS t, generate_series(0, 19) AS p;

INSERT INTO patients (id, "tenantId", "firstName", "lastName", "docNumber", "updatedAt")
SELECT md5('dx423-patient:' || t || ':' || n)::uuid,
       ('00000000-0000-4000-a000-00000000042' || t)::uuid,
       'Paciente', 'Bench ' || n, (3000000000 + n)::text, now()
  FROM generate_series(3, 4) AS t, generate_series(0, 19999) AS n;

INSERT INTO dental_catalog_items (id, "tenantId", code, kind, "labelEs", category, color, "defaultPrice", "updatedAt")
SELECT md5('dx423-cat:' || t || ':' || c)::uuid,
       ('00000000-0000-4000-a000-00000000042' || t)::uuid,
       'P' || lpad(c::text, 3, '0'), 'PROCEDURE', 'Procedimiento ' || c,
       'Categoría ' || (c % 8), '#2A2B3C', 50000 + c * 1000, now()
  FROM generate_series(3, 4) AS t, generate_series(0, 59) AS c;

-- Un plan cada dos ítems.
INSERT INTO treatment_plans (id, "tenantId", "patientId", status, currency, "updatedAt")
SELECT md5('dx423-plan:' || t || ':' || n)::uuid,
       ('00000000-0000-4000-a000-00000000042' || t)::uuid,
       md5('dx423-patient:' || t || ':' || (n % 20000))::uuid, 'ACCEPTED',
       CASE WHEN n % 10 = 0 THEN 'USD' ELSE 'COP' END, now()
  FROM generate_series(3, 4) AS t,
       generate_series(0, 111999) AS n
 WHERE t = 3 OR n < 25000;

-- Realizados: 200.000 en el tenant del bench (50.000 en el de ruido), 24
-- meses de lunes a sábado repartidos por día, sede, profesional y hora.
INSERT INTO treatment_plan_items (id, "tenantId", "planId", "toothNumber", "catalogItemId",
                                  price, discount, "basePrice", "catalogPrice", status,
                                  "performedById", "performedByMembershipId",
                                  "performedLocationId", "completedAt", "updatedAt")
SELECT md5('dx423-item:' || t || ':' || n)::uuid,
       ('00000000-0000-4000-a000-00000000042' || t)::uuid,
       md5('dx423-plan:' || t || ':' || (n / 2))::uuid, '16',
       md5('dx423-cat:' || t || ':' || (n % 60))::uuid,
       CASE WHEN (n / 2) % 10 = 0 THEN 60 ELSE 60000 END,
       CASE WHEN n % 5 = 0 THEN (CASE WHEN (n / 2) % 10 = 0 THEN 6 ELSE 6000 END) ELSE 0 END,
       CASE WHEN (n / 2) % 10 = 0 THEN 65 ELSE 65000 END,
       CASE WHEN (n / 2) % 10 = 0 THEN 65 ELSE 65000 END,
       'DONE',
       md5('dx423-user:' || t || ':' || (n % 20))::uuid,
       md5('dx423-member:' || t || ':' || (n % 20))::uuid,
       md5('dx423-loc:' || t || ':' || (1 + n % 5))::uuid,
       timestamp '2024-11-01 13:00' + (n % 730) * interval '1 day'
         + ((n / 730) % 600) * interval '1 minute',
       now()
  FROM generate_series(3, 4) AS t, generate_series(0, 199999) AS n
 WHERE t = 3 OR n < 50000;

-- Ruido del mismo tenant: propuestos/aceptados, borrados y «Sin atribuir».
INSERT INTO treatment_plan_items (id, "tenantId", "planId", "toothNumber", "catalogItemId",
                                  price, discount, status, "deletedAt",
                                  "performedById", "performedByMembershipId",
                                  "performedLocationId", "completedAt", "updatedAt")
SELECT md5('dx423-noise:' || n)::uuid, '00000000-0000-4000-a000-000000000423',
       md5('dx423-plan:3:' || (100000 + n / 2))::uuid, '16',
       md5('dx423-cat:3:' || (n % 60))::uuid, 60000, 0,
       (CASE WHEN n < 20000 THEN (CASE WHEN n % 2 = 0 THEN 'PROPOSED' ELSE 'ACCEPTED' END)
             ELSE 'DONE' END)::"TreatmentPlanItemStatus",
       CASE WHEN n >= 20000 AND n < 22000 THEN now() END,
       CASE WHEN n >= 20000 AND n < 22000 THEN md5('dx423-user:3:' || (n % 20))::uuid END,
       CASE WHEN n >= 20000 AND n < 22000 THEN md5('dx423-member:3:' || (n % 20))::uuid END,
       CASE WHEN n >= 20000 AND n < 22000 THEN md5('dx423-loc:3:' || (1 + n % 5))::uuid END,
       CASE WHEN n >= 20000 AND n < 22000 THEN timestamp '2025-06-01 15:00' END,
       now()
  FROM generate_series(0, 21999 + 500) AS n;

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
ANALYZE treatment_plan_items;
ANALYZE treatment_plans;
ANALYZE dental_catalog_items;
