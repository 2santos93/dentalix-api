-- DX-019: VALIDATE sola (SHARE UPDATE EXCLUSIVE): no bloquea lecturas ni
-- escrituras de `prescriptions`, y se separa del ADD COLUMN por lo mismo que
-- DX-515 con `payments`.
ALTER TABLE "prescriptions" VALIDATE CONSTRAINT "prescriptions_clinic_fiscal_check";
