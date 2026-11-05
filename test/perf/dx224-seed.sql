-- DX-224 · siembra para dx224-bench.ts: una clínica con 60.000 pacientes con
-- teléfono (y su E.164) y 10.000 contactos responsables. Base DESECHABLE
-- (dx224_test), como owner (DIRECT_URL): `psql "$DIRECT_URL" -f dx224-seed.sql`.
-- Teléfonos de ejemplo de una sede con +58; el número buscado por el bench
-- (0412 5550000) lo tienen 3 pacientes (grupo familiar).
BEGIN;
DELETE FROM patient_responsible_parties WHERE "tenantId" = '00000000-0000-4000-a000-0000000000e4';
DELETE FROM patients WHERE "tenantId" = '00000000-0000-4000-a000-0000000000e4';
DELETE FROM locations WHERE "tenantId" = '00000000-0000-4000-a000-0000000000e4';
DELETE FROM tenants WHERE id = '00000000-0000-4000-a000-0000000000e4';

INSERT INTO tenants (id, name, subdomain, "updatedAt")
VALUES ('00000000-0000-4000-a000-0000000000e4', 'DX-224 bench', 'dx224-bench', now());

INSERT INTO locations (id, "tenantId", name, "countryCode", currency, "timeZone", locale, "hourCycle", "defaultPhoneRegion", "updatedAt")
VALUES ('00000000-0000-4000-a000-0000000001e4', '00000000-0000-4000-a000-0000000000e4',
        'Sede bench', 'VE', 'VES', 'America/Caracas', 'es-VE', 'h23', 'VE', now());

INSERT INTO patients (id, "tenantId", "firstName", "lastName", phone, "phoneE164", "updatedAt")
SELECT gen_random_uuid(), '00000000-0000-4000-a000-0000000000e4',
       'Nombre' || g, 'Apellido' || (g % 5000),
       '0412 ' || lpad(g::text, 7, '0'),
       '+58412' || lpad(g::text, 7, '0'),
       now()
  FROM generate_series(1, 60000) g;

-- Tres pacientes con el mismo número (grupo familiar).
-- Dos sentencias: cambiar `phone` anula el E.164 (trigger dx_phone_e164_stale).
UPDATE patients SET phone = '0412 5550000'
 WHERE "tenantId" = '00000000-0000-4000-a000-0000000000e4'
   AND id IN (SELECT id FROM patients
               WHERE "tenantId" = '00000000-0000-4000-a000-0000000000e4'
               ORDER BY id LIMIT 3);
UPDATE patients SET "phoneE164" = '+584125550000'
 WHERE "tenantId" = '00000000-0000-4000-a000-0000000000e4'
   AND phone = '0412 5550000';

INSERT INTO patient_responsible_parties (id, "tenantId", "patientId", "fullName", phone, "phoneE164", relationship, "updatedAt")
SELECT gen_random_uuid(), '00000000-0000-4000-a000-0000000000e4', p.id,
       'Responsable ' || p.n, '0414 ' || lpad(p.n::text, 7, '0'),
       '+58414' || lpad(p.n::text, 7, '0'), 'MOTHER', now()
  FROM (SELECT id, row_number() OVER (ORDER BY id) AS n
          FROM patients
         WHERE "tenantId" = '00000000-0000-4000-a000-0000000000e4'
         LIMIT 10000) p;

ANALYZE patients;
ANALYZE patient_responsible_parties;
COMMIT;
