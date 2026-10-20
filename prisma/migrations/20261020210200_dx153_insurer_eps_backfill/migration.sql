-- DX-153: el texto libre de la ficha (patients."insurerEps") pasa a ser un
-- pagador de la clínica y una cobertura principal del paciente.
--
-- - Un pagador POR CLÍNICA y texto normalizado (dx_search_normalize del texto
--   sin espacios sobrantes: «Sura EPS» y «  sura eps » son el mismo). Su
--   nombre es el texto original (máx. 120) del paciente más antiguo con esa
--   clave; tipo OTRO y sin país (no se puede inferir; el ADMIN lo reclasifica).
-- - Una cobertura por paciente con texto no vacío, principal, sin plan, afiliado
--   ni vigencia, marcada "migratedFromInsurerEps".
-- - Archivados y suprimidos parcialmente INCLUIDOS: no se pierde el dato de
--   nadie.
-- - patients."insurerEps" NO se toca (queda DEPRECADO, solo lectura).
--
-- IDEMPOTENTE: payers_tenant_name_key y patient_coverages_migrated_key con ON
-- CONFLICT DO NOTHING; volver a ejecutarla no crea nada más.
--
-- row_security = off y NO FORCE durante la copia: con RLS FORCE el owner sin
-- BYPASSRLS vería 0 pacientes y la copia no haría nada en silencio (DX-113,
-- como 20261018150100_dx203_guardian_to_responsible). Se restaura en la misma
-- transacción.

SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';

ALTER TABLE "patients" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "payers" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "patient_coverages" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "payers" ("id", "tenantId", "name", "type", "country", "active", "createdAt", "updatedAt")
SELECT gen_random_uuid(), s."tenantId", s."name", 'OTRO', NULL, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM (
    SELECT DISTINCT ON (p."tenantId", public.dx_search_normalize(btrim(p."insurerEps")))
           p."tenantId", left(btrim(p."insurerEps"), 120) AS "name"
      FROM "patients" p
     WHERE NULLIF(btrim(p."insurerEps"), '') IS NOT NULL
     ORDER BY p."tenantId", public.dx_search_normalize(btrim(p."insurerEps")), p."createdAt", p."id"
  ) s
ON CONFLICT ("tenantId", "name") WHERE "deletedAt" IS NULL DO NOTHING;

INSERT INTO "patient_coverages" ("id", "tenantId", "patientId", "payerId", "isPrimary", "migratedFromInsurerEps", "createdAt", "updatedAt")
SELECT gen_random_uuid(), p."tenantId", p."id", y."id", true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM "patients" p
  JOIN LATERAL (
    -- El pagador de su clave normalizada (un nombre ya existente que solo
    -- cambie en mayúsculas o tildes también vale).
    SELECT py."id"
      FROM "payers" py
     WHERE py."tenantId" = p."tenantId"
       AND py."deletedAt" IS NULL
       AND public.dx_search_normalize(py."name") = public.dx_search_normalize(left(btrim(p."insurerEps"), 120))
     ORDER BY py."createdAt", py."id"
     LIMIT 1
  ) y ON true
 WHERE NULLIF(btrim(p."insurerEps"), '') IS NOT NULL
ON CONFLICT ("tenantId", "patientId") WHERE "migratedFromInsurerEps" DO NOTHING;

ALTER TABLE "patient_coverages" FORCE ROW LEVEL SECURITY;
ALTER TABLE "payers" FORCE ROW LEVEL SECURITY;
ALTER TABLE "patients" FORCE ROW LEVEL SECURITY;
