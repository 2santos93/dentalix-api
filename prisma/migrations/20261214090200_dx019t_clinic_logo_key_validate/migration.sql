-- DX-019-ter: VALIDATE sola (SHARE UPDATE EXCLUSIVE): no bloquea lecturas ni
-- escrituras de `patient_consents` ni de `post_op_instruction_deliveries`, y
-- se separa del ADD COLUMN (20261214090000_dx019t_clinic_logo_key) como
-- 20261203090200_dx019b_clinic_logo_key_validate. El relleno
-- (20261214090100_dx019t_clinic_logo_key_backfill) ya escribe solo valores
-- que cumplen el CHECK.
ALTER TABLE "patient_consents" VALIDATE CONSTRAINT "patient_consents_clinic_logo_key_check";
ALTER TABLE "post_op_instruction_deliveries" VALIDATE CONSTRAINT "post_op_instruction_deliveries_clinic_logo_key_check";
