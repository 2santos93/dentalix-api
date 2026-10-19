-- DX-203: el acudiente guardado como texto libre en la ficha
-- (patients."guardianName" / "guardianDocNumber") pasa a ser un contacto
-- responsable del paciente.
--
-- - Solo los pacientes con alguno de los dos con valor (sin espacios). Sin
--   nombre pero con documento, el contacto se llama «Acudiente» (el nombre es
--   obligatorio) y recepción lo completa en la ficha.
-- - Parentesco LEGAL_GUARDIAN, recibe los avisos (como hacía DX-128 al
--   saludarlo en los recordatorios) y NO es pagador: no se sabe quién paga.
-- - Retirados incluidos: no se pierde el dato de nadie.
-- - Los campos antiguos NO se tocan (quedan de solo lectura, DEPRECADO).
--
-- IDEMPOTENTE: el índice único parcial patient_responsible_parties_migrated_key
-- deja una sola copia por paciente; volver a ejecutar esta sentencia (o
-- ejecutarla tras quitar el contacto en la ficha) no crea otra.
--
-- row_security = off y NO FORCE durante la copia: con RLS FORCE el owner sin
-- BYPASSRLS vería 0 pacientes y la copia no haría nada en silencio (DX-113,
-- como 20261017233300_dx128_contact_channel). Se restaura en la misma
-- transacción.

SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';

ALTER TABLE "patients" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "patient_responsible_parties" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "patient_responsible_parties"
  ("id", "tenantId", "patientId", "fullName", "docNumber", "relationship",
   "isPayer", "receivesNotices", "migratedFromGuardian", "createdAt", "updatedAt")
SELECT gen_random_uuid(), p."tenantId", p."id",
       left(coalesce(NULLIF(btrim(p."guardianName"), ''), 'Acudiente'), 200),
       left(NULLIF(btrim(p."guardianDocNumber"), ''), 60),
       'LEGAL_GUARDIAN', false, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "patients" p
 WHERE NULLIF(btrim(p."guardianName"), '') IS NOT NULL
    OR NULLIF(btrim(p."guardianDocNumber"), '') IS NOT NULL
ON CONFLICT ("tenantId", "patientId") WHERE "migratedFromGuardian" DO NOTHING;

ALTER TABLE "patient_responsible_parties" FORCE ROW LEVEL SECURITY;
ALTER TABLE "patients" FORCE ROW LEVEL SECURITY;
