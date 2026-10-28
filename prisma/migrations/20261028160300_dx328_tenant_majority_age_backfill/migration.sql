-- DX-328: relleno de una sola vez de `tenants."majorityAge"` (columna creada en
-- 20261028160200_dx328_tenant_majority_age). Cada clínica conserva la edad con
-- la que la app trata hoy a sus pacientes, que hasta ahora salía del país de
-- sus sedes:
--
--   locations.country | edad que aplica hoy
--   ------------------+--------------------
--   CO                | 18
--   ES                | 16
--
-- Esta tabla es el ÚNICO sitio con la correspondencia país → edad y vive solo
-- en esta migración: ningún código de `src/` la repite.
--
--   - Cuentan TODAS las sedes de la clínica, también las retiradas: un abono o
--     una cita de una sede retirada sigue contando la edad con su país.
--   - Decisión Q1 del dueño (2026-10-28): si las sedes de una clínica tienen
--     edades distintas, recibe la MAYOR, para que ningún paciente que hoy es
--     menor pase a adulto por la migración. Sin aviso de revisión; el ADMIN
--     la cambia en Ajustes si quiere.
--   - Una clínica sin sedes se queda en el default de plataforma (18).
--   - Un país sin fila en la tabla hace fallar la migración (RAISE EXCEPTION)
--     en vez de inventar una edad.
--   - Al final se comprueba el resultado y, si no cuadra, la migración falla.
--
-- Bloqueos (pre-flight I1): en `tenants` solo ROW EXCLUSIVE y bloqueos de
-- fila del UPDATE; ningún ALTER TABLE "tenants". El ACCESS EXCLUSIVE de
-- `locations` (NO FORCE/FORCE) es el único bloqueo de tabla fuerte de esta
-- transacción.
--
-- row_security = off y NO FORCE durante el relleno (DX-113/DX-134): en
-- producción el owner no es superusuario ni BYPASSRLS; con FORCE vería 0
-- sedes y el relleno (y su comprobación) no harían nada en silencio. FORCE
-- se restaura en esta misma transacción. lock_timeout: si una transacción
-- larga retiene `locations`, falla limpia y se reintenta el deploy.
--
-- Sin trigger UTC (DX-226): no hay columnas de fecha. Grants: no aplica.

SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';

ALTER TABLE "locations" NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  unmapped bigint;
  wrong bigint;
BEGIN
  -- Relleno: por clínica, la mayor edad de sus sedes. Un país sin fila da
  -- NULL en el CASE y se cuenta aparte.
  WITH ages AS (
    SELECT l."tenantId",
           max(CASE l."country"::text WHEN 'CO' THEN 18 WHEN 'ES' THEN 16 END) AS age,
           bool_or((CASE l."country"::text WHEN 'CO' THEN 18 WHEN 'ES' THEN 16 END) IS NULL) AS unmapped
      FROM "locations" l
     GROUP BY l."tenantId"
  ), updated AS (
    UPDATE "tenants" t
       SET "majorityAge" = a.age
      FROM ages a
     WHERE t."id" = a."tenantId"
       AND NOT a.unmapped
       AND t."majorityAge" IS DISTINCT FROM a.age
  )
  -- El UPDATE del WITH se ejecuta siempre, se lea o no (PG: «data-modifying
  -- statements in WITH»). Si hay un país sin fila, el RAISE lo deshace.
  SELECT count(*) FILTER (WHERE a.unmapped) INTO unmapped FROM ages a;
  IF unmapped > 0 THEN
    RAISE EXCEPTION 'DX-328: % clínica(s) con una sede de un país sin edad en el relleno', unmapped;
  END IF;

  -- Comprobación: con alguna sede CO, 18; con sedes ES y ninguna CO, 16.
  SELECT count(*) INTO wrong
    FROM "tenants" t
    JOIN (
      SELECT l."tenantId",
             bool_or(l."country"::text = 'CO') AS has_co,
             bool_or(l."country"::text = 'ES') AS has_es
        FROM "locations" l
       GROUP BY l."tenantId"
    ) s ON s."tenantId" = t."id"
   WHERE (s.has_co AND t."majorityAge" <> 18)
      OR (s.has_es AND NOT s.has_co AND t."majorityAge" <> 16);
  IF wrong > 0 THEN
    RAISE EXCEPTION 'DX-328: % clínica(s) sin la edad que aplicaban tras el relleno', wrong;
  END IF;
END
$$;

ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;
