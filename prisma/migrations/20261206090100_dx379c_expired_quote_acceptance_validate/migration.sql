-- DX-379 (C): valida los dos CHECK y la FK que
-- 20261206090000_dx379c_expired_quote_acceptance añadió NOT VALID. Todas las
-- filas existentes tienen las columnas nuevas a NULL, que cumplen los CHECK y
-- no tocan la FK (MATCH SIMPLE: con `repricingId` NULL no se comprueba).
--
-- VALIDATE CONSTRAINT solo toma SHARE UPDATE EXCLUSIVE sobre
-- `treatment_plan_acceptances` (y ROW SHARE sobre la referenciada).
--
-- FK bajo FORCE (DX-134): validar una FK lee la hija y la referenciada con la
-- RLS del owner, así que se quita FORCE a las dos en esta misma transacción y
-- se devuelve al final.
--
-- Vuelta atrás: no hace falta (las restricciones siguen existiendo NOT VALID
-- si se omite); la de la migración anterior las retira.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "treatment_plan_acceptances" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_repricings" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_expired_check";
ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_expired_note_check";
ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_repricing_fkey";
ALTER TABLE "treatment_plan_repricings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_acceptances" FORCE ROW LEVEL SECURITY;
