-- DX-172: VALIDATE de las FK y CHECK de patients añadidos NOT VALID en
-- 20270117090000. Columnas nuevas, todas NULL: no hay nada que corregir. Va en
-- su propia transacción (molde de DX-266, 20261226140100). DX-134: la
-- validación lee patients y patient_sources con la RLS del owner; sin NO FORCE
-- no vería las filas de ninguna clínica. FORCE de vuelta al final.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "patients" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "patient_sources" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_source_fkey";
ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_referred_by_fkey";
ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_referred_by_self_check";
ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_referral_needs_source_check";
ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_referral_one_check";
ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_referred_by_name_check";
ALTER TABLE "patient_sources" FORCE ROW LEVEL SECURITY;
ALTER TABLE "patients" FORCE ROW LEVEL SECURITY;
