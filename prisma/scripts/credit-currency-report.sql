-- DX-438 (DB-066): consulta de diagnóstico (solo lectura) de los asientos de
-- saldo a favor cuya moneda no es la de su plan. Esos asientos no cuentan en
-- ningún saldo (las lecturas suman solo la moneda actual del plan): es saldo
-- del paciente que no se ve. Desde 20261107140000_dx438_credit_currency_lock
-- ya no se pueden producir; con DX-253 recién desplegado debería dar 0 filas.
-- No borra ni cambia nada: corregirlos es decisión de la clínica.
--
-- Por clínica, como la app: con el rol dentalix_app y la clínica fijada (la
-- RLS deja ver solo sus filas):
--   BEGIN; SET LOCAL ROLE dentalix_app;
--   SELECT pg_catalog.set_config('app.current_tenant', '<tenantId>', true);
--   \i prisma/scripts/credit-currency-report.sql
--   ROLLBACK;
-- O todas las clínicas a la vez, con un rol BYPASSRLS o superusuario (el del
-- DBA):
--   psql "<URL del rol BYPASSRLS, sin ?schema>" -X -v ON_ERROR_STOP=1 -f prisma/scripts/credit-currency-report.sql
-- Sin clínica fijada y sin BYPASSRLS (p. ej. el owner de producción, con FORCE
-- RLS) no vería ningún asiento: en vez de un falso «todo bien» devuelve solo
-- la fila NO_CLINIC_VISIBLE. Una sola sentencia.
--
-- Columnas: problema, clínica, paciente, plan, asiento, tipo, traspaso o
-- devolución, moneda e importe del asiento y moneda actual del plan.
--   ENTRY_CURRENCY_MISMATCH  el asiento está en otra moneda que su plan.
--   NO_CLINIC_VISIBLE        el rol no ve ninguna clínica: repetir con la
--                            clínica fijada o con un rol BYPASSRLS.
SELECT 'ENTRY_CURRENCY_MISMATCH' AS "problem", e."tenantId", e."patientId",
       e."treatmentPlanId", e."id" AS "entryId", e."kind"::text AS "kind",
       e."transferId", e."refundId", e."currency" AS "entryCurrency",
       e."amount", tp."currency" AS "planCurrency"
  FROM "patient_credit_entries" e
  JOIN "treatment_plans" tp
    ON tp."tenantId" = e."tenantId" AND tp."id" = e."treatmentPlanId"
 WHERE e."currency" <> tp."currency"
UNION ALL
SELECT 'NO_CLINIC_VISIBLE', NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid,
       NULL::text, NULL::uuid, NULL::uuid, NULL::text, NULL::numeric, NULL::text
 WHERE coalesce(pg_catalog.current_setting('app.current_tenant', true), '') = ''
   AND NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_roles r
      WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)
   )
ORDER BY 1, 2, 3, 4, 5;
