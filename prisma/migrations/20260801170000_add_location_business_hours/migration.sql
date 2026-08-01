-- Horario de atencion por SEDE. Hasta ahora se podia agendar a cualquier hora
-- (3 AM, domingo, en medio del cierre de mediodia): la agenda no conocia el
-- horario de la clinica.
--
-- Dos tablas propias, sin tocar "locations": el trabajo multi-sede
-- (docs/plans/2026-08-01-multi-sede.md) esta modificando ese modelo en las
-- Fases 2-5, asi que el vinculo es un puntero suave "locationId" (mismo criterio
-- que ToothRecord.sourcePlanItemId). Una FK a nivel DB queda como follow-up.

-- CreateTable: una fila por sede con su zona horaria.
CREATE TABLE "location_schedules" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Bogota',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "location_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable: los tramos. Dia CERRADO = sin filas para ese weekday.
CREATE TABLE "location_schedule_ranges" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "scheduleId" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_schedule_ranges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "location_schedule_tenant_location_key" ON "location_schedules"("tenantId", "locationId");
CREATE INDEX "location_schedules_tenantId_idx" ON "location_schedules"("tenantId");
CREATE INDEX "location_schedule_ranges_tenantId_scheduleId_weekday_idx" ON "location_schedule_ranges"("tenantId", "scheduleId", "weekday");

-- AddForeignKey: los tramos SI cuelgan de su schedule (tabla propia), en cascada
-- para que reemplazar la semana borre los tramos viejos sin trabajo extra.
ALTER TABLE "location_schedule_ranges" ADD CONSTRAINT "location_schedule_ranges_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "location_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Sanidad a nivel DB: un tramo tiene que ser un rango valido dentro del dia.
ALTER TABLE "location_schedule_ranges" ADD CONSTRAINT "location_schedule_ranges_valid_range"
  CHECK ("startMinute" >= 0 AND "endMinute" > "startMinute" AND "endMinute" <= 1440);
ALTER TABLE "location_schedule_ranges" ADD CONSTRAINT "location_schedule_ranges_valid_weekday"
  CHECK ("weekday" >= 0 AND "weekday" <= 6);

-- RLS: igual que toda tabla de dominio con tenantId (ver 20260801150000_add_locations).
ALTER TABLE "location_schedules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "location_schedules" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "location_schedules"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE "location_schedule_ranges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "location_schedule_ranges" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "location_schedule_ranges"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

-- Grants: no se requiere GRANT explicito. Corre con el rol owner "dentalix"
-- (via DIRECT_URL) y ALTER DEFAULT PRIVILEGES ya otorga DML a dentalix_app sobre
-- toda tabla nueva -- igual que las migraciones previas.
--
-- Compatibilidad: no se siembra ningun horario. Una sede SIN LocationSchedule no
-- tiene restriccion, asi que este despliegue no cambia el comportamiento de
-- ninguna clinica existente; la restriccion arranca cuando alguien configura su
-- horario.
