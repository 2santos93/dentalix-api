-- DX-101-bis: VALIDATE de la FK al enlace de acceso y del CHECK de evidencias
-- que 20270115140000 añadió NOT VALID, en su propia transacción.
--
-- DX-134: con FORCE, el owner validaría la FK con la RLS (sin tenant no ve
-- filas): NO FORCE en la hija y en la referenciada mientras se valida y FORCE
-- de vuelta en las dos al acabar (molde de 20261106160100_dx415_remote_budget).
--
-- Bloqueo: el VALIDATE solo toma SHARE UPDATE EXCLUSIVE, pero el ALTER TABLE
-- … NO FORCE ROW LEVEL SECURITY de antes toma ACCESS EXCLUSIVE sobre
-- treatment_plan_acceptances y patient_access_links hasta el COMMIT: mientras
-- dura la migración, las lecturas y escrituras de esas dos tablas (aceptar un
-- presupuesto, verificar o abrir el portal) ESPERAN. Breve: el recorrido de
-- validación es de dos tablas pequeñas y la FK solo mira filas con la columna
-- nueva, todas NULL; las que lleguen detrás pueden fallar por su
-- lock_timeout y se reintentan.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "treatment_plan_acceptances" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "patient_access_links" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_patient_access_link_fkey";
ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_remote_check";
ALTER TABLE "treatment_plan_acceptances" FORCE ROW LEVEL SECURITY;
ALTER TABLE "patient_access_links" FORCE ROW LEVEL SECURITY;
