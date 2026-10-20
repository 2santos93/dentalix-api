-- DX-233: horario de cada profesional por sede, con excepciones por fecha.
--
-- Cambios:
--   tenants."providerScheduleStrict"   ajuste de la clínica: false (defecto)
--                      = una cita fuera del horario del profesional se agenda
--                      con aviso; true = la API la rechaza con 409.
--   provider_schedules   un horario vivo por profesional y sede (único
--                      PARCIAL), con la zona de la sede al guardar.
--   provider_schedule_ranges   tramos semanales (día 0–6, minutos de pared).
--   provider_schedule_overrides   excepción por fecha civil de una sede, que
--                      prevalece sobre el semanal ese día (una viva por
--                      profesional, sede y fecha: único PARCIAL).
--   provider_schedule_override_ranges   tramos de la excepción; sin tramos
--                      vivos la excepción es «no trabaja».
--
-- Reglas en la BD (la API responde antes con 400 en español; esto es la red):
--   - minutos múltiplos de 5, 0 <= inicio < fin <= 1440 (un tramo no cruza
--     la medianoche), día de la semana 0–6, nota de hasta 200 caracteres;
--   - EXCLUDE: dos tramos VIVOS del mismo profesional no se solapan el mismo
--     día de la semana (semanal) ni la misma fecha (excepciones), en NINGUNA
--     sede: el profesional no puede estar en dos sitios a la vez. El tramo
--     lleva el profesional (y la fecha) del padre por FK compuesta, así que
--     no puede mentir sobre de quién es;
--   - FK COMPUESTAS por tenant (SEC-004) a la sede y entre tablas. Van DENTRO
--     del CREATE TABLE (las tablas nacen vacías), así el owner sin BYPASSRLS
--     no necesita ver filas de las referenciadas (DX-134);
--   - `providerId` sin FK, como appointments y schedule_blocks (la membresía
--     solo tiene un único PARCIAL): la API exige un miembro activo que atiende;
--   - RLS FORZADA por tenant en las cuatro tablas. Sin datos de pacientes.
--
-- Compatible hacia atrás: solo AÑADE (una columna con DEFAULT constante, que
-- en Postgres 11+ no reescribe la tabla, y cuatro tablas vacías). Sin
-- backfill: un profesional sin horario no tiene restricción.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas.

SET LOCAL lock_timeout = '5s';

-- btree_gist ya lo habilitó 20260731161000 (EXCLUDE de las citas).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- 1. Ajuste de la clínica
-- ---------------------------------------------------------------------------
ALTER TABLE "tenants"
  ADD COLUMN "providerScheduleStrict" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2. Horario semanal
-- ---------------------------------------------------------------------------
CREATE TABLE "provider_schedules" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "timezone" TEXT NOT NULL,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "provider_schedules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "provider_schedules_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTA: la sede es de la MISMA clínica.
    CONSTRAINT "provider_schedules_tenantId_locationId_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "provider_schedules_timezone_check"
      CHECK (char_length("timezone") BETWEEN 1 AND 64)
);

-- Destino de la FK compuesta de los tramos.
CREATE UNIQUE INDEX "provider_schedules_tenant_id_provider_key"
  ON "provider_schedules"("tenantId", "id", "providerId");
-- Un horario VIVO por profesional y sede; también sirve la lectura por
-- profesional (prefijo tenantId, providerId).
CREATE UNIQUE INDEX "provider_schedules_live_key"
  ON "provider_schedules"("tenantId", "providerId", "locationId")
  WHERE "deletedAt" IS NULL;
-- Lado hijo de la FK a la sede (no parcial) y roster por sede.
CREATE INDEX "provider_schedules_tenant_location_idx"
  ON "provider_schedules"("tenantId", "locationId");

CREATE TABLE "provider_schedule_ranges" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "scheduleId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "provider_schedule_ranges_pkey" PRIMARY KEY ("id"),
    -- FK COMPUESTA con el profesional: el tramo es del horario y del
    -- profesional que dice, de la MISMA clínica. RESTRICT: el padre se borra
    -- en blando; un borrado duro solo puede ser un error.
    CONSTRAINT "provider_schedule_ranges_tenantId_scheduleId_providerId_fkey"
      FOREIGN KEY ("tenantId", "scheduleId", "providerId")
      REFERENCES "provider_schedules"("tenantId", "id", "providerId")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "provider_schedule_ranges_weekday_check"
      CHECK ("weekday" BETWEEN 0 AND 6),
    CONSTRAINT "provider_schedule_ranges_minutes_check" CHECK (
      "startMinute" >= 0 AND "endMinute" <= 1440 AND "endMinute" > "startMinute"
      AND "startMinute" % 5 = 0 AND "endMinute" % 5 = 0
    ),
    -- Sin solape entre tramos vivos del mismo profesional y día, en ninguna
    -- sede. Medio abierto '[)': contiguos (8:00–13:00 y 13:00–14:00) valen.
    CONSTRAINT "provider_schedule_ranges_no_overlap" EXCLUDE USING gist (
      "tenantId" WITH =,
      "providerId" WITH =,
      "weekday" WITH =,
      int4range("startMinute", "endMinute", '[)') WITH &&
    ) WHERE ("deletedAt" IS NULL)
);

-- Lado hijo de la FK (tenantId, scheduleId, providerId) y lectura de los
-- tramos vivos de un horario.
CREATE INDEX "provider_schedule_ranges_tenant_schedule_idx"
  ON "provider_schedule_ranges"("tenantId", "scheduleId", "providerId");
CREATE INDEX "provider_schedule_ranges_tenant_provider_weekday_idx"
  ON "provider_schedule_ranges"("tenantId", "providerId", "weekday");

-- ---------------------------------------------------------------------------
-- 3. Excepciones por fecha
-- ---------------------------------------------------------------------------
CREATE TABLE "provider_schedule_overrides" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "note" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "provider_schedule_overrides_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "provider_schedule_overrides_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "provider_schedule_overrides_tenantId_locationId_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "provider_schedule_overrides_note_check"
      CHECK ("note" IS NULL OR char_length("note") <= 200)
);

CREATE UNIQUE INDEX "provider_schedule_overrides_tenant_id_provider_date_key"
  ON "provider_schedule_overrides"("tenantId", "id", "providerId", "date");
-- Una excepción VIVA por profesional, sede y fecha.
CREATE UNIQUE INDEX "provider_schedule_overrides_live_key"
  ON "provider_schedule_overrides"("tenantId", "providerId", "locationId", "date")
  WHERE "deletedAt" IS NULL;
-- Excepciones de un profesional en un rango de fechas (lista, reglas).
CREATE INDEX "provider_schedule_overrides_tenant_provider_date_idx"
  ON "provider_schedule_overrides"("tenantId", "providerId", "date");
-- Lado hijo de la FK a la sede y roster por sede y semana.
CREATE INDEX "provider_schedule_overrides_tenant_location_date_idx"
  ON "provider_schedule_overrides"("tenantId", "locationId", "date");

CREATE TABLE "provider_schedule_override_ranges" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "overrideId" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "provider_schedule_override_ranges_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "provider_schedule_override_ranges_tenantId_overrideId_prov_fkey"
      FOREIGN KEY ("tenantId", "overrideId", "providerId", "date")
      REFERENCES "provider_schedule_overrides"("tenantId", "id", "providerId", "date")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "provider_schedule_override_ranges_minutes_check" CHECK (
      "startMinute" >= 0 AND "endMinute" <= 1440 AND "endMinute" > "startMinute"
      AND "startMinute" % 5 = 0 AND "endMinute" % 5 = 0
    ),
    CONSTRAINT "provider_schedule_override_ranges_no_overlap" EXCLUDE USING gist (
      "tenantId" WITH =,
      "providerId" WITH =,
      "date" WITH =,
      int4range("startMinute", "endMinute", '[)') WITH &&
    ) WHERE ("deletedAt" IS NULL)
);

CREATE INDEX "provider_schedule_override_ranges_tenant_override_idx"
  ON "provider_schedule_override_ranges"("tenantId", "overrideId", "providerId", "date");

-- ---------------------------------------------------------------------------
-- 4. RLS forzada por tenant en las cuatro tablas.
-- ---------------------------------------------------------------------------
ALTER TABLE "provider_schedules" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "provider_schedules"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
ALTER TABLE "provider_schedules" FORCE ROW LEVEL SECURITY;

ALTER TABLE "provider_schedule_ranges" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "provider_schedule_ranges"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
ALTER TABLE "provider_schedule_ranges" FORCE ROW LEVEL SECURITY;

ALTER TABLE "provider_schedule_overrides" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "provider_schedule_overrides"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
ALTER TABLE "provider_schedule_overrides" FORCE ROW LEVEL SECURITY;

ALTER TABLE "provider_schedule_override_ranges" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "provider_schedule_override_ranges"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
ALTER TABLE "provider_schedule_override_ranges" FORCE ROW LEVEL SECURITY;
