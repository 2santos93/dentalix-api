-- DX-266: valida la FK y el CHECK de patients."mergedIntoId" (20261226140000),
-- que nacen NOT VALID. La columna es nueva: todas las filas están a NULL y
-- la validación no encuentra nada. DX-134: la validación lee patients con la
-- RLS del owner; sin NO FORCE no vería las filas de ninguna clínica. FORCE de
-- vuelta al final.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "patients" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_merged_into_fkey";
ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_merged_into_check";
ALTER TABLE "patients" FORCE ROW LEVEL SECURITY;
