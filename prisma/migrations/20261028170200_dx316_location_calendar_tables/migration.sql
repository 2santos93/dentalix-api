-- DX-316 (G1.5, epic DX-311 «Producto global, sin supuestos de país»):
-- calendario de días hábiles y festivos de cada sede, para los plazos en días
-- hábiles. Dentalix no trae festivos de ningún país ni deduce los días
-- hábiles del país, la zona o el locale de la sede: los carga la clínica.
--
-- Cambios:
--   location_working_calendars  días hábiles de la semana de la sede, 1:1 con
--                               ella (0 = domingo … 6 = sábado). No es el
--                               horario de atención (location_schedules), que
--                               decide cuándo se puede citar.
--   location_holidays           festivo de la sede: puntual (esa fecha) o
--                               recurrente (cada año ese mes y día). Se
--                               retira en blando ("deletedAt").
--
-- La fila de calendario de cada sede la crean el trigger de alta de sede y el
-- backfill de 20261028170300_dx316_location_calendar_default (otra
-- transacción, con su propio bracket NO FORCE/FORCE sobre `locations`). Esta
-- migración no altera `locations` ni su RLS (pre-flight I1), pero sus FK sí
-- la bloquean: cada CREATE TABLE toma SHARE ROW EXCLUSIVE primero en
-- `tenants` y después en `locations`, hasta el COMMIT. Ese modo no choca con
-- los ROW SHARE / KEY SHARE de las comprobaciones de FK; solo frena las
-- escrituras en las dos tablas mientras dura.
--
-- Reglas en la BD:
--   * FK de clínica y FK COMPUESTA (tenantId, locationId) → locations(tenantId,
--     id) dentro del CREATE TABLE (tablas vacías; SEC-004, DX-134).
--       - Calendario: ON DELETE CASCADE. La fila es de la sede 1:1; la app
--         nunca borra sedes en duro (no-hard-delete.ts), así que el CASCADE
--         solo afecta a las limpiezas de test y a la purga de la demo
--         (pre-flight C3).
--       - Festivos: ON DELETE RESTRICT. Solo se crean a propósito; una sede
--         con festivos no se borra en duro.
--       - FK de clínica, en las dos tablas: ON DELETE CASCADE. Es
--         configuración de la sede, como location_reminder_settings; con
--         RESTRICT, borrar una clínica con sedes fallaría por la fila que
--         el trigger crea en cada una.
--   * Días hábiles: array de una dimensión, de 1 a 7 días, entre 0 y 6 y sin
--     NULL. El orden y los repetidos los normaliza la API
--     (normalizeWorkingWeekdays): un repetido no cambia el significado.
--   * Festivos: fecha entre 2000-01-01 y 2100-12-31 (PERIOD_DAY_MIN/MAX);
--     nombre de 1 a 120 caracteres, sin espacios en los extremos ni
--     caracteres de control; un recurrente no puede ser el 29 de febrero.
--   * Índices únicos parciales entre los festivos vivos: un puntual por fecha
--     y un recurrente por mes y día, sea cual sea el año. El choque entre
--     clases (puntual y recurrente con el mismo mes y día) NO es una
--     restricción de la BD: lo garantiza la API bajo el FOR UPDATE de la fila
--     de calendario.
--   * "createdAt" lo pone la BD en UTC (DX-226), no el reloj de la API.
--   * RLS FORCE por tenant en las dos tablas.
--
-- Compatible hacia atrás: solo AÑADE dos tablas vacías, sus índices, una
-- función y sus triggers. El código anterior no las conoce.
--
-- lock_timeout 5 s: las FK toman SHARE ROW EXCLUSIVE en `tenants` y en
-- `locations` mientras se crean; si una transacción larga las retiene, falla
-- limpia. Prisma la deja marcada como fallida (otro `migrate deploy` se para
-- con P3009): se ejecuta `npx prisma migrate resolve --rolled-back
-- 20261028170200_dx316_location_calendar_tables` y se repite
-- `migrate deploy`.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en tablas nuevas
-- (SELECT, INSERT, UPDATE y DELETE; UPDATE hace falta para el FOR UPDATE de
-- la importación).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- location_working_calendars
-- ---------------------------------------------------------------------------
CREATE TABLE "location_working_calendars" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "workingWeekdays" SMALLINT[] NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "location_working_calendars_pkey" PRIMARY KEY ("id"),
    -- CASCADE: configuración de la sede, como location_reminder_settings (20261017210600_dx026_appointment_reminders).
    CONSTRAINT "location_working_calendars_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "location_working_calendars_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "location_working_calendars_weekdays_check"
      CHECK (
        array_ndims("workingWeekdays") = 1
        AND cardinality("workingWeekdays") BETWEEN 1 AND 7
        AND "workingWeekdays" <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]
        AND array_position("workingWeekdays", NULL) IS NULL
      )
);
-- Una fila por sede (R2) y lado hijo de las dos FK.
CREATE UNIQUE INDEX "location_working_calendars_tenant_location_key"
  ON "location_working_calendars"("tenantId", "locationId");

-- ---------------------------------------------------------------------------
-- location_holidays
-- ---------------------------------------------------------------------------
CREATE TABLE "location_holidays" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "location_holidays_pkey" PRIMARY KEY ("id"),
    -- CASCADE: configuración de la sede, como location_reminder_settings (20261017210600_dx026_appointment_reminders).
    CONSTRAINT "location_holidays_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "location_holidays_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "location_holidays_date_check"
      CHECK ("date" BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
    CONSTRAINT "location_holidays_name_check"
      CHECK (
        char_length("name") BETWEEN 1 AND 120
        AND "name" = btrim("name")
        AND "name" !~ '[[:cntrl:]]'
      ),
    CONSTRAINT "location_holidays_recurring_feb29_check"
      CHECK (NOT ("recurring" AND EXTRACT(MONTH FROM "date") = 2 AND EXTRACT(DAY FROM "date") = 29))
);
-- Festivos de una sede por fecha (lectura del calendario) y lado hijo de las
-- dos FK.
CREATE INDEX "location_holidays_tenantId_locationId_date_idx"
  ON "location_holidays"("tenantId", "locationId", "date");
-- Un puntual por fecha entre los vivos de la sede.
CREATE UNIQUE INDEX "location_holidays_one_off_key"
  ON "location_holidays"("tenantId", "locationId", "date")
  WHERE NOT "recurring" AND "deletedAt" IS NULL;
-- Un recurrente por mes y día entre los vivos de la sede, sea cual sea el año.
CREATE UNIQUE INDEX "location_holidays_recurring_key"
  ON "location_holidays"("tenantId", "locationId", (EXTRACT(MONTH FROM "date")), (EXTRACT(DAY FROM "date")))
  WHERE "recurring" AND "deletedAt" IS NULL;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
-- Alta con la hora del servidor en UTC (DX-226, copia de
-- dx_expense_server_created_at). Solo el INSERT: lo que venga en "createdAt"
-- (el reloj de la API) no cuenta.
CREATE FUNCTION public.dx_location_calendar_server_created_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER "location_working_calendars_server_created_at"
  BEFORE INSERT ON "location_working_calendars"
  FOR EACH ROW EXECUTE FUNCTION public.dx_location_calendar_server_created_at();
CREATE TRIGGER "location_holidays_server_created_at"
  BEFORE INSERT ON "location_holidays"
  FOR EACH ROW EXECUTE FUNCTION public.dx_location_calendar_server_created_at();

-- ---------------------------------------------------------------------------
-- RLS FORCE
-- ---------------------------------------------------------------------------
ALTER TABLE "location_working_calendars" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "location_holidays" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "location_working_calendars"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY tenant_isolation ON "location_holidays"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "location_working_calendars" FORCE ROW LEVEL SECURITY;
ALTER TABLE "location_holidays" FORCE ROW LEVEL SECURITY;
