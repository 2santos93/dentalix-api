-- DX-172: VALIDATE de las FK y CHECK de patients añadidos NOT VALID en
-- 20270117090000. Columnas nuevas, todas NULL: no hay nada que corregir. Va en
-- su propia transacción: SHARE UPDATE EXCLUSIVE lee la tabla sin bloquear las
-- escrituras (molde de DX-285 / DX-556).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_source_fkey";
ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_referred_by_fkey";
ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_referred_by_self_check";
ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_referral_needs_source_check";
ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_referral_one_check";
ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_referred_by_name_check";
