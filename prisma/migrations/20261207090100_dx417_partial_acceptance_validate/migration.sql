-- DX-417: valida los dos CHECK y las dos FK que
-- 20261207090000_dx417_partial_acceptance añadió NOT VALID. Todas las filas
-- existentes tienen las columnas nuevas a NULL, que cumplen los CHECK y no
-- tocan las FK (MATCH SIMPLE: con la columna NULL no se comprueba).
--
-- Bloqueos:
--   1. Los dos CHECK se validan PRIMERO y con FORCE puesto: un CHECK ve todas
--      las filas aunque haya RLS FORCE (solo las FK la sufren, DX-134), y
--      VALIDATE CONSTRAINT solo toma SHARE UPDATE EXCLUSIVE (no bloquea
--      lecturas ni escrituras).
--   2. Las FK sí necesitan quitar FORCE a la hija y a la referenciada (DX-134:
--      su validación lee las dos con la RLS del owner). `NO FORCE ROW LEVEL
--      SECURITY` es un ALTER TABLE: toma ACCESS EXCLUSIVE en las dos tablas
--      hasta el COMMIT (como DX-379 C), así que dentro de ese tramo solo van
--      los VALIDATE de las FK. La de "splitFromPlanId" es de treatment_plans
--      consigo misma: recorre la tabla una vez (todas las filas a NULL, sin
--      búsquedas en el índice). FORCE se devuelve en la misma transacción:
--      ninguna otra sesión ve las tablas sin FORCE.
--
-- Vuelta atrás: no hace falta (las restricciones siguen existiendo NOT VALID
-- si se omite); la de la migración anterior las retira.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "treatment_plans" VALIDATE CONSTRAINT "treatment_plans_split_from_check";
ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_pending_check";

ALTER TABLE "treatment_plan_acceptances" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plans" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plans" VALIDATE CONSTRAINT "treatment_plans_split_from_fkey";
ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_pending_plan_fkey";
ALTER TABLE "treatment_plans" FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_acceptances" FORCE ROW LEVEL SECURITY;
