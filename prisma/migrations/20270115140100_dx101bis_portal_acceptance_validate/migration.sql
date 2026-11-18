-- DX-101-bis: VALIDATE de la FK al enlace de acceso y del CHECK de evidencias
-- que 20270115140000 añadió NOT VALID. En su propia transacción (SHARE UPDATE
-- EXCLUSIVE: no bloquea las escrituras).
--
-- DX-134: con FORCE, el owner validaría la FK con la RLS (sin tenant no ve
-- filas): NO FORCE en la hija y en la referenciada mientras se valida y FORCE
-- de vuelta en las dos al acabar (molde de 20261106160100_dx415_remote_budget).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "treatment_plan_acceptances" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "patient_access_links" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_patient_access_link_fkey";
ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_remote_check";
ALTER TABLE "treatment_plan_acceptances" FORCE ROW LEVEL SECURITY;
ALTER TABLE "patient_access_links" FORCE ROW LEVEL SECURITY;
