-- G1-B fase 1 (DX-350, cierra DX-315 «formato por sede»; epic DX-311
-- «Producto global, sin supuestos de país»): cada sede tiene su reloj, 12 h o
-- 24 h, como ajuste explícito. Nunca se deduce del país ni del locale.
--
-- Despliegue sin parada en dos fases (expand/contract, el patrón de GLOBAL-G1
-- §2.0). Esta es la FASE 1: se aplica con las réplicas de G1 sirviendo, así
-- que solo añade columnas NULL, rellena y añade CHECK que admiten NULL:
--   - una réplica de G1 que crea una sede sin nombrar "hourCycle" sigue
--     funcionando (queda NULL); el barrido `location-regional-backfill` la
--     rellena con la misma función de abajo;
--   - un registro pendiente creado por una web de G1 queda con
--     "locationHourCycle" NULL y `verify` llama a la función.
-- Fase 2 (se suma al ticket de fase 2 de G1; spec G1-B §12): tras
-- `npm run g1:backfill-locations -- --check` = 0, SET NOT NULL en las dos
-- columnas (borrando antes los pendientes caducados sin reloj) y DROP de esta
-- función.
--
-- Pasos:
--   1. `locations."hourCycle"`: NULL, sin default, CHECK h12/h23.
--   2. `pending_registrations."locationHourCycle"`: igual (sin RLS).
--   3. Función `dx_g1b_backfill_location_hour_cycle(p_tenant)`: el ÚNICO
--      sitio que rellena un reloj NULL (R5). Pone el reloj con el que la app
--      pinta hoy las horas de toda sede, 'h23': las pantallas componen 24 h a
--      mano para todas. Idempotente (solo filas NULL, nunca pisa un reloj
--      elegido) y no toca "regionalSettingsReviewedAt": el valor no cambia
--      nada de lo que se ve, así que no hace falta aviso de revisión.
--      Cambio visible acordado (ruling del controlador, 2026-10-27): los
--      recordatorios por correo y su vista previa que salían en 12 h pasan a
--      24 h; cada ADMIN puede elegir 12 h en Ajustes › Sedes.
--   4. Backfill de todas las sedes y comprobación: si queda alguna NULL, la
--      migración falla en vez de seguir.
--
-- row_security = off y NO FORCE durante el backfill (DX-113/DX-134): en
-- producción el owner no es superusuario ni BYPASSRLS; con FORCE vería 0
-- sedes y el backfill (y su comprobación) no harían nada en silencio. FORCE
-- se restaura en esta misma transacción. lock_timeout: si una transacción
-- larga retiene `locations`, falla limpia y se reintenta el deploy.
--
-- Grants: la función es SECURITY INVOKER y solo la ejecutan el owner (esta
-- migración) y `dentalix_app` (barrido por clínica bajo `runWithTenant`, el
-- script `g1:backfill-locations` y las ramas de compatibilidad de
-- POST /locations y de `verify`), con la RLS de quien llama.

SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';

-- 1. y 2. Columnas (NULL, sin default: un INSERT de G1 sigue valiendo).
ALTER TABLE "locations"
  ADD COLUMN "hourCycle" TEXT,
  ADD CONSTRAINT "locations_hour_cycle_check"
    CHECK ("hourCycle" IS NULL OR "hourCycle" IN ('h12', 'h23'));

ALTER TABLE "pending_registrations"
  ADD COLUMN "locationHourCycle" TEXT,
  ADD CONSTRAINT "pending_registrations_location_hour_cycle_check"
    CHECK ("locationHourCycle" IS NULL OR "locationHourCycle" IN ('h12', 'h23'));

-- 3. Backfill del reloj (spec G1-B §3.1, R5, R6). Con p_tenant solo barre esa
-- clínica.
CREATE OR REPLACE FUNCTION public.dx_g1b_backfill_location_hour_cycle(p_tenant uuid DEFAULT NULL)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  updated integer;
BEGIN
  UPDATE public."locations" AS l
     SET "hourCycle" = 'h23'
   WHERE l."hourCycle" IS NULL
     AND (p_tenant IS NULL OR l."tenantId" = p_tenant);
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated;
END;
$$;

COMMENT ON FUNCTION public.dx_g1b_backfill_location_hour_cycle(uuid) IS
  'G1-B fase 1 (DX-350): reloj h23 (el que la app ya pintaba) en las sedes con "hourCycle" NULL. Fase 2: DROP (spec G1-B §12).';

REVOKE ALL ON FUNCTION public.dx_g1b_backfill_location_hour_cycle(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app') THEN
    GRANT EXECUTE ON FUNCTION public.dx_g1b_backfill_location_hour_cycle(uuid) TO dentalix_app;
  END IF;
END
$$;

-- 4. Backfill de todas las sedes (también las retiradas) y comprobación.
ALTER TABLE "locations" NO FORCE ROW LEVEL SECURITY;

SELECT public.dx_g1b_backfill_location_hour_cycle();

DO $$
DECLARE
  missing bigint;
BEGIN
  SELECT count(*) INTO missing FROM "locations" WHERE "hourCycle" IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION 'G1-B: % sede(s) sin reloj tras el backfill', missing;
  END IF;
END
$$;

ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;
