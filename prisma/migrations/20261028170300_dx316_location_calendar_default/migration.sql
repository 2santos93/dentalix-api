-- DX-316 (G1.5): toda sede, nueva o existente, tiene un calendario con los
-- días hábiles por defecto y ningún festivo (R2, R3). Tablas creadas en
-- 20261028170200_dx316_location_calendar_tables.
--
-- Pasos:
--   1. `dx_location_default_working_weekdays()`: los días hábiles por defecto,
--      lunes a viernes. Es el valor de plataforma aprobado por el dueño, no
--      el de ningún país, y este es el ÚNICO sitio con el literal: lo llaman
--      el trigger y el backfill. No hay default en TypeScript.
--   2. `dx_location_default_working_calendar()` y el trigger
--      `locations_default_working_calendar` (AFTER INSERT ON locations): toda
--      sede nace con su fila, venga de POST /locations, del registro, de una
--      réplica anterior durante un despliegue rolling o de un INSERT crudo
--      (semillas, fixtures). SECURITY INVOKER: corre con la RLS de quien
--      inserta (POST /locations va dentro de runWithTenant y el registro fija
--      `app.current_tenant` antes de crear la sede), así que el WITH CHECK
--      acepta la fila de la misma clínica. Un trigger se ejecuta sin mirar
--      EXECUTE: no hace falta GRANT. Se crea ANTES del backfill para que no
--      se escape ninguna sede creada mientras tanto.
--   3. Backfill de las sedes existentes, también las retiradas (R2 es para
--      toda fila), y comprobación: si queda alguna sede sin calendario, la
--      migración falla en vez de seguir.
--
-- row_security = off y NO FORCE durante el backfill (DX-113/DX-134): en
-- producción el owner no es superusuario ni BYPASSRLS; con FORCE vería 0
-- sedes y el backfill (y su comprobación) no harían nada en silencio. FORCE
-- se restaura en esta misma transacción en las dos tablas.
--
-- Bloqueos (pre-flight I1): ACCESS EXCLUSIVE en `locations` desde el primer
-- paso que la toca (LOCK TABLE antes del CREATE TRIGGER, sin subir de
-- bloqueo después) y en `location_working_calendars` (NO FORCE/FORCE);
-- ningún ALTER TABLE "tenants". lock_timeout 10 s: si una transacción larga
-- retiene `locations`, falla limpia. Prisma la deja marcada como fallida
-- (otro `migrate deploy` se para con P3009): se ejecuta `npx prisma migrate
-- resolve --rolled-back 20261028170300_dx316_location_calendar_default` y se
-- repite `migrate deploy`.
--
-- Un INSERT crudo en `locations` hecho por el owner con el bracket habitual
-- (row_security = off y NO FORCE solo en `locations`) falla ahora: el
-- trigger inserta en `location_working_calendars`, que sigue en FORCE, y la
-- RLS lo rechaza. Ese INSERT tiene que poner también NO FORCE/FORCE en
-- `location_working_calendars`.
--
-- Compatible hacia atrás: una réplica anterior que crea una sede sin conocer
-- las tablas recibe su calendario por el trigger. Sin fase 2.
--
-- Grants: no aplica (funciones SECURITY INVOKER; las tablas ya están
-- cubiertas por ALTER DEFAULT PRIVILEGES).

SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';

-- 1. Días hábiles por defecto (0 = domingo … 6 = sábado).
CREATE FUNCTION public.dx_location_default_working_weekdays() RETURNS smallint[]
  LANGUAGE sql
  IMMUTABLE
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT '{1,2,3,4,5}'::smallint[]
$$;

-- ACCESS EXCLUSIVE sobre `locations` ANTES del CREATE TRIGGER (que solo pide
-- SHARE ROW EXCLUSIVE): sin subir de bloqueo después en el NO FORCE, no hay
-- interbloqueo con un PATCH de sede que ya tenga su FOR UPDATE (review M1).
-- Lo acota el lock_timeout de arriba.
LOCK TABLE "locations" IN ACCESS EXCLUSIVE MODE;

-- 2. Calendario de toda sede nueva.
CREATE FUNCTION public.dx_location_default_working_calendar() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO public.location_working_calendars
    ("id", "tenantId", "locationId", "workingWeekdays", "updatedAt")
  VALUES (
    pg_catalog.gen_random_uuid(), NEW."tenantId", NEW."id",
    public.dx_location_default_working_weekdays(),
    pg_catalog.timezone('UTC', pg_catalog.now())
  )
  ON CONFLICT ("tenantId", "locationId") DO NOTHING;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "locations_default_working_calendar"
  AFTER INSERT ON "locations"
  FOR EACH ROW EXECUTE FUNCTION public.dx_location_default_working_calendar();

-- 3. Backfill de todas las sedes (también las retiradas) y comprobación.
ALTER TABLE "locations" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "location_working_calendars" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "location_working_calendars"
  ("id", "tenantId", "locationId", "workingWeekdays", "updatedAt")
SELECT gen_random_uuid(), l."tenantId", l."id",
       public.dx_location_default_working_weekdays(),
       timezone('UTC', now())
  FROM "locations" l
ON CONFLICT ("tenantId", "locationId") DO NOTHING;

DO $$
DECLARE
  missing bigint;
BEGIN
  SELECT count(*) INTO missing
    FROM "locations" l
   WHERE NOT EXISTS (
     SELECT 1 FROM "location_working_calendars" c
      WHERE c."tenantId" = l."tenantId" AND c."locationId" = l."id");
  IF missing > 0 THEN
    RAISE EXCEPTION 'dx316: % sedes sin calendario', missing;
  END IF;
END
$$;

ALTER TABLE "location_working_calendars" FORCE ROW LEVEL SECURITY;
ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;
