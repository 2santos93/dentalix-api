-- DX-305 (BE-045): desde cuándo ESTA base registra la producción atribuible.
--
-- DX-050 (20261023160000_dx050_plan_item_attribution) empezó a guardar quién,
-- dónde y cuándo se realiza cada procedimiento; los DONE de antes quedaron «Sin
-- atribuir» (sin sede ni fecha). «Comparar sedes» necesita saber si el período
-- con el que compara empieza antes de eso: su producción estaría incompleta y
-- la variación saldría como una «mejora» falsa.
--
-- La fecha no se inventa ni se fija en el código (cada entorno desplegó DX-050
-- en su momento): es el `finished_at` de la migración de DX-050 en
-- `_prisma_migrations` de esta base, que la app (dentalix_app) no puede leer.
-- Esta migración, que corre como el owner, lo copia como LITERAL en el cuerpo
-- de una función sin acceso a tablas, que la app sí puede ejecutar. Así la fecha
-- es verificable (`\sf dx_production_attributed_since` muestra el instante y
-- coincide con `_prisma_migrations`) y no depende de los grants de esa tabla.
-- Sin fila de DX-050 (no debería pasar: esta migración va después; sí en una
-- base sin `_prisma_migrations`, como la sombra de `migrate dev`) se usa el
-- instante de esta migración, que es una cota superior: compara con cautela.
-- En una base nueva (CI, un entorno recién creado) las dos corren en el mismo
-- `migrate deploy` y la fecha es la de creación: no hay datos anteriores.
-- Re-ejecutarla es idempotente (CREATE OR REPLACE con la misma fila de DX-050).
-- Prefijo 20261024151000 (no 150000): SEC-050 usa 20261024150000…150200.
--
-- Cambios:
--   función public.dx_production_attributed_since() RETURNS timestamptz:
--     IMMUTABLE, sin acceso a tablas, search_path fijo (SEC-032); EXECUTE solo
--     para dentalix_app.
--
-- Compatible hacia atrás: solo AÑADE una función; no toca tablas, RLS ni datos.

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  attributed_since timestamptz;
BEGIN
  -- Sin `_prisma_migrations` (base sombra de `migrate dev`, o el SQL aplicado
  -- a mano) no hay fila que leer: SQL dinámico para no fallar al compilar.
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE $q$
      SELECT min(m."finished_at")
        FROM public."_prisma_migrations" m
       WHERE m."migration_name" = '20261023160000_dx050_plan_item_attribution'
         AND m."finished_at" IS NOT NULL
         AND m."rolled_back_at" IS NULL
    $q$ INTO attributed_since;
  END IF;
  EXECUTE format(
    $ddl$
      CREATE OR REPLACE FUNCTION public."dx_production_attributed_since"()
        RETURNS timestamptz
        LANGUAGE sql
        IMMUTABLE
        PARALLEL SAFE
        SET search_path = pg_catalog, pg_temp
      AS $body$ SELECT %L::timestamptz $body$
    $ddl$,
    coalesce(attributed_since, now())
  );
END
$$;

REVOKE ALL ON FUNCTION public."dx_production_attributed_since"() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app') THEN
    GRANT EXECUTE ON FUNCTION public."dx_production_attributed_since"() TO dentalix_app;
  END IF;
END
$$;
