-- DX-058-bis: VALIDATE de las tres FK que 20270207100000 añadió NOT VALID.
-- Su propia transacción: SHARE UPDATE EXCLUSIVE lee la tabla sin bloquear las
-- escrituras (molde de DX-265 / DX-132). DX-134: la validación lee la hija con
-- la RLS del owner; sin NO FORCE no vería las filas de ninguna clínica y
-- aceptaría huérfanas en silencio. FORCE de vuelta al final. tenants (la
-- referenciada) no tiene RLS.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "patients" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "locations" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "location_schedules" NO FORCE ROW LEVEL SECURITY;

ALTER TABLE "patients" VALIDATE CONSTRAINT "patients_tenantId_fkey";
ALTER TABLE "locations" VALIDATE CONSTRAINT "locations_tenantId_fkey";
ALTER TABLE "location_schedules" VALIDATE CONSTRAINT "location_schedules_tenantId_fkey";

ALTER TABLE "location_schedules" FORCE ROW LEVEL SECURITY;
ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "patients" FORCE ROW LEVEL SECURITY;
