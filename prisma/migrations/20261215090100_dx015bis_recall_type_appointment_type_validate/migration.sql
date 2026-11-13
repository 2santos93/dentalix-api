-- DX-015-bis (D20): valida la FK de 20261215090000 (todas las filas están a
-- NULL). DX-134: la validación lee las dos tablas con la RLS del owner; sin
-- NO FORCE no vería las filas de ninguna clínica. FORCE de vuelta al final.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "recall_types" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointment_types" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "recall_types" VALIDATE CONSTRAINT "recall_types_appointment_type_fkey";
ALTER TABLE "recall_types" FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointment_types" FORCE ROW LEVEL SECURITY;
