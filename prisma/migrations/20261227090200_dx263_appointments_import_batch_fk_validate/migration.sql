-- DX-263: valida appointments_import_batch_fkey (añadida NOT VALID en
-- 20261227090000) y el CHECK de la hoja de citas del lote, sin recorrer
-- appointments. Mismo procedimiento que
-- 20261022130400_dx107_patients_import_batch_fk_validate:
--
--   1. ANALYZE de la columna antes del NO FORCE (SHARE UPDATE EXCLUSIVE, no
--      bloquea): estadística «todo NULL», así la comprobación del VALIDATE
--      (filas con import_batch_id NOT NULL sin lote) usa el índice parcial
--      appointments_tenant_import_batch_idx (20261227090100) y no lee la tabla.
--   2. DX-134: NO FORCE en la hija (appointments) y en la referenciada
--      (patient_import_batches) mientras se valida, y FORCE al final, en la
--      misma transacción.
--
-- La columna nació entera a NULL y la FK NOT VALID ya se aplica a toda fila
-- nueva o modificada: no puede haber huérfanas. lock_timeout acota la espera
-- (si appointments está ocupada, falla en 5 s sin dejar nada a medias y se
-- repite). Compatible hacia atrás: no cambia el esquema.

SET LOCAL lock_timeout = '5s';

ANALYZE "appointments" ("import_batch_id");

ALTER TABLE "appointments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "patient_import_batches" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments" VALIDATE CONSTRAINT "appointments_import_batch_fkey";
ALTER TABLE "patient_import_batches" VALIDATE CONSTRAINT "patient_import_batches_appointment_sheet_check";
ALTER TABLE "patient_import_batches" FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;
