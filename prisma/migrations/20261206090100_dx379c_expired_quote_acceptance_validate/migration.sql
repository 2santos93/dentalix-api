-- DX-379 (C): valida los dos CHECK y la FK que
-- 20261206090000_dx379c_expired_quote_acceptance añadió NOT VALID. Todas las
-- filas existentes tienen las columnas nuevas a NULL, que cumplen los CHECK y
-- no tocan la FK (MATCH SIMPLE: con `repricingId` NULL no se comprueba).
--
-- Bloqueos:
--   1. Los dos CHECK se validan PRIMERO y con FORCE puesto: un CHECK ve todas
--      las filas aunque haya RLS FORCE (solo las FK la sufren, DX-134), y
--      VALIDATE CONSTRAINT solo toma SHARE UPDATE EXCLUSIVE (no bloquea
--      lecturas ni escrituras de `treatment_plan_acceptances`).
--   2. La FK sí necesita quitar FORCE a la hija y a la referenciada (DX-134:
--      su validación lee las dos con la RLS del owner). `NO FORCE ROW LEVEL
--      SECURITY` es un ALTER TABLE: toma ACCESS EXCLUSIVE en las dos tablas
--      hasta el COMMIT (como DX-107), así que dentro de ese tramo solo va el
--      VALIDATE de la FK, que usa el índice parcial
--      `treatment_plan_acceptances_repricing_idx` del lado hijo. FORCE se
--      devuelve en la misma transacción: ninguna otra sesión ve las tablas
--      sin FORCE.
--
-- Vuelta atrás: no hace falta (las restricciones siguen existiendo NOT VALID
-- si se omite); la de la migración anterior las retira.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_expired_check";
ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_expired_note_check";

ALTER TABLE "treatment_plan_acceptances" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_repricings" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_repricing_fkey";
ALTER TABLE "treatment_plan_repricings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_acceptances" FORCE ROW LEVEL SECURITY;
