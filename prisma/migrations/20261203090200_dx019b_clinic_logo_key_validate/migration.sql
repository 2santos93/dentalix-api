-- DX-019-bis (B): VALIDATE sola (SHARE UPDATE EXCLUSIVE): no bloquea lecturas
-- ni escrituras de `prescriptions` ni de `treatment_plan_acceptances`, y se
-- separa del ADD COLUMN (20261203090000_dx019b_clinic_logo_key) por lo mismo
-- que 20261114100100_dx019_prescription_fiscal_check_validate. El relleno
-- (20261203090100_dx019b_clinic_logo_key_backfill) ya escribe solo valores
-- que cumplen el CHECK.
ALTER TABLE "prescriptions" VALIDATE CONSTRAINT "prescriptions_clinic_logo_key_check";
ALTER TABLE "treatment_plan_acceptances" VALIDATE CONSTRAINT "treatment_plan_acceptances_clinic_logo_key_check";
