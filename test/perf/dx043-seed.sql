-- DX-043 · siembra del benchmark (NO es parte de la suite; ver dx043-bench.sh).
-- Corre como owner (superusuario, sin RLS) en una base DESECHABLE ya migrada.
-- Determinista: sin random(); todo sale de generate_series.
--   Tenant A "bench-a": 50.000 pacientes (0,5 % retirados), 2 sedes,
--                       20 profesionales, 300.000 citas (1 % retiradas,
--                       5 % canceladas) de 2026-04-01 a 2027-02-07.
--   Tenant B "bench-b": 10.000 pacientes, 1 sede, 10 profesionales,
--                       50.000 citas. Sirve de "ruido" y de prueba de aislamiento.
--   Términos raros: 3 "Arismendi" en A y 1 en B; documento 7700012345 solo en A.
\set ON_ERROR_STOP on
BEGIN;

-- Nombres con y sin tilde: "jose" tiene que encontrar "José".
CREATE TEMP TABLE first_names(i int, v text) ON COMMIT DROP;
INSERT INTO first_names SELECT ordinality - 1, v FROM unnest(ARRAY[
  'José','María','Juan','Ana','Luis','Carmen','Jesús','Andrés','Lucía','Sofía',
  'Camilo','Valentina','Sebastián','Daniela','Nicolás','Mónica','Ramón','Inés',
  'Óscar','Ángela','Jose','Maria','Pedro','Laura','Felipe','Paula','Diego',
  'Natalia','Julián','Martín']) WITH ORDINALITY AS t(v, ordinality);
CREATE TEMP TABLE last_names(i int, v text) ON COMMIT DROP;
INSERT INTO last_names SELECT ordinality - 1, v FROM unnest(ARRAY[
  'Pérez','Gómez','Rodríguez','Martínez','López','García','Hernández','Díaz',
  'Muñoz','Álvarez','Ramírez','Torres','Ruiz','Vásquez','Castaño','Peña',
  'Núñez','Ospina','Restrepo','Zuluaga','Cardona','Jaramillo','Mejía','Sánchez',
  'Rojas','Moreno','Quintero','Salazar','Giraldo','Londoño']) WITH ORDINALITY AS t(v, ordinality);

INSERT INTO tenants (id, name, subdomain, "updatedAt") VALUES
  ('00000000-0000-4000-a000-00000000000a', 'Bench A', 'bench-a', now()),
  ('00000000-0000-4000-a000-00000000000b', 'Bench B', 'bench-b', now());
INSERT INTO locations (id, "tenantId", name, "updatedAt") VALUES
  ('00000000-0000-4000-b000-0000000000a1', '00000000-0000-4000-a000-00000000000a', 'Sede A1', now()),
  ('00000000-0000-4000-b000-0000000000a2', '00000000-0000-4000-a000-00000000000a', 'Sede A2', now()),
  ('00000000-0000-4000-b000-0000000000b1', '00000000-0000-4000-a000-00000000000b', 'Sede B1', now());

-- Pacientes. createdAt repartido en ~3 años; id derivado de (tenant, n) para
-- que dos corridas den el mismo dataset.
CREATE TEMP TABLE bench_patients ON COMMIT DROP AS
SELECT t.tenant_id, n,
       md5(t.tenant_id::text || ':' || n)::uuid AS id
  FROM (VALUES ('00000000-0000-4000-a000-00000000000a'::uuid, 50000),
               ('00000000-0000-4000-a000-00000000000b'::uuid, 10000)) AS t(tenant_id, total),
       generate_series(0, t.total - 1) AS n;

INSERT INTO patients (id, "tenantId", "firstName", "lastName", "docNumber",
                      "createdAt", "updatedAt", "deletedAt")
SELECT p.id, p.tenant_id,
       f.v,
       l1.v || ' ' || l2.v,
       (1000000000 + p.n)::text,
       timestamp '2023-10-01' + (p.n * interval '30 minutes'),
       now(),
       CASE WHEN p.n % 200 = 199 THEN timestamp '2026-09-01' END
  FROM bench_patients p
  JOIN first_names f ON f.i = p.n % 30
  JOIN last_names l1 ON l1.i = (p.n / 30) % 30
  JOIN last_names l2 ON l2.i = (p.n / 900) % 30;

-- Términos raros (un nombre poco común y un documento único).
UPDATE patients SET "lastName" = 'Arismendi Peña'
 WHERE id IN (SELECT id FROM bench_patients
               WHERE tenant_id = '00000000-0000-4000-a000-00000000000a'
                 AND n IN (1234, 22222, 40001));
UPDATE patients SET "lastName" = 'Arismendi Ruiz'
 WHERE id = (SELECT id FROM bench_patients
              WHERE tenant_id = '00000000-0000-4000-a000-00000000000b' AND n = 777);
UPDATE patients SET "docNumber" = '7700012345'
 WHERE id = (SELECT id FROM bench_patients
              WHERE tenant_id = '00000000-0000-4000-a000-00000000000a' AND n = 31337);

-- Citas: slot de 30 min por profesional; el paciente rota (i % pacientes),
-- así ni el profesional ni el paciente se solapan (EXCLUDE por tenant).
INSERT INTO appointments (id, "tenantId", "patientId", "providerId", "locationId",
                          start, "end", status, "updatedAt", "deletedAt")
SELECT md5('appt:' || t.tenant_id::text || ':' || i)::uuid,
       t.tenant_id,
       md5(t.tenant_id::text || ':' || (i % t.patients))::uuid,
       md5('prov:' || t.tenant_id::text || ':' || (i % t.providers))::uuid,
       CASE WHEN t.tenant_id = '00000000-0000-4000-a000-00000000000b'
            THEN '00000000-0000-4000-b000-0000000000b1'::uuid
            WHEN (i % t.providers) % 2 = 0 THEN '00000000-0000-4000-b000-0000000000a1'::uuid
            ELSE '00000000-0000-4000-b000-0000000000a2'::uuid END,
       timestamp '2026-04-01' + ((i / t.providers) * interval '30 minutes'),
       timestamp '2026-04-01' + ((i / t.providers) * interval '30 minutes') + interval '30 minutes',
       (CASE WHEN i % 20 = 7 THEN 'CANCELLED' ELSE 'SCHEDULED' END)::"AppointmentStatus",
       now(),
       CASE WHEN i % 100 = 42 THEN timestamp '2026-09-01' END
  FROM (VALUES ('00000000-0000-4000-a000-00000000000a'::uuid, 300000, 50000, 20),
               ('00000000-0000-4000-a000-00000000000b'::uuid, 50000, 10000, 10))
         AS t(tenant_id, total, patients, providers),
       generate_series(0, t.total - 1) AS i;

COMMIT;
VACUUM ANALYZE patients;
VACUUM ANALYZE appointments;
