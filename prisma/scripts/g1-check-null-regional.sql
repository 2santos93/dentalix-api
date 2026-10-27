-- GLOBAL-G1: comprobación de «0 sedes sin configurar» (runbook de la fase 1 y
-- precondición de la fase 2). Se corre COMO EL OWNER de la base:
--
--   psql "${DIRECT_URL%%\?*}" -X -tA -v ON_ERROR_STOP=1 -f prisma/scripts/g1-check-null-regional.sql
--
-- `locations` tiene FORCE ROW LEVEL SECURITY: sin clínica fijada el owner (que
-- no es superusuario ni BYPASSRLS) lee 0 filas y un `count(*)` suelto daría un
-- falso 0. Por eso quita FORCE DENTRO de una transacción que termina en
-- ROLLBACK (la migración usa el mismo patrón): FORCE vuelve solo. Si algo
-- falla, ON_ERROR_STOP sale con error en lugar de un 0.
-- `pending_registrations` no tiene RLS. `${DIRECT_URL%%\?*}` quita el
-- `?schema=` de Prisma, que psql no admite.
BEGIN;
ALTER TABLE public."locations" NO FORCE ROW LEVEL SECURITY;
SELECT 'locations_sin_configurar=' || count(*) FROM public."locations"
 WHERE currency IS NULL OR "timeZone" IS NULL OR locale IS NULL;
ROLLBACK;
SELECT 'pendientes_legados_vigentes=' || count(*) FROM public."pending_registrations"
 WHERE "locationCurrency" IS NULL AND "expiresAt" > now();
