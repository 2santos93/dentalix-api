-- DX-132: VALIDATE de la FK y el CHECK que 20270206140000 añadió NOT VALID.
-- Su propia transacción: SHARE UPDATE EXCLUSIVE lee la tabla sin bloquear las
-- escrituras (molde de DX-265 / DX-465). Columna nueva, toda NULL: no hay nada
-- que corregir. DX-134: la FK es de tooth_records a sí misma; la validación
-- lee la tabla con la RLS del owner y sin NO FORCE no vería las filas de
-- ninguna clínica (molde de DX-172). FORCE de vuelta al final.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "tooth_records" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "tooth_records" VALIDATE CONSTRAINT "tooth_records_replacesRecordId_fkey";
ALTER TABLE "tooth_records" VALIDATE CONSTRAINT "tooth_records_replaces_check";
ALTER TABLE "tooth_records" FORCE ROW LEVEL SECURITY;
