-- DX-324: relleno de una sola vez de los ajustes de receta de cada clínica
-- (columnas creadas en 20261028180300_dx324_tenant_prescription_settings).
-- Cada clínica conserva lo que la app le hace hoy, que hasta ahora salía del
-- país de la sede desde la que se emite:
--
--   locations.country | nº de historia clínica | validez (días)
--   ------------------+------------------------+---------------
--   CO                | exigido                | 30
--   ES                | no exigido             | 10
--
--   prescriptionRequireClinicalRecordNumber = true si alguna sede viva es CO.
--   prescriptionPrintQuantityInWords        = true si la clínica tiene alguna
--                                             sede viva (hoy toda receta la
--                                             imprime; decisión Q1).
--   prescriptionValidityDays                = la menor validez de sus sedes
--                                             vivas (decisión Q2).
--
-- Esta tabla es el ÚNICO sitio con la correspondencia país → ajuste de
-- receta y vive solo en esta migración: ningún código de `src/` la repite.
--
--   - Cuentan solo las sedes VIVAS ("deletedAt" IS NULL): una sede retirada
--     no emite recetas, así que no decide lo que la app le hace hoy a la
--     clínica (pre-flight I7).
--   - Una clínica sin sedes vivas se queda con los valores de plataforma
--     (false, false y 30).
--   - Una sede viva con un país sin fila en la tabla hace fallar la migración
--     (RAISE EXCEPTION) en vez de inventar un ajuste.
--   - Al final se comprueba el resultado y, si no cuadra, la migración falla.
--
-- Bloqueos: el primer bloqueo de tabla es el ACCESS EXCLUSIVE de `locations`
-- (NO FORCE), así que no hay subida de bloqueo a mitad de la transacción. En
-- `tenants` solo ROW EXCLUSIVE y bloqueos de fila del UPDATE, en las filas
-- que cambian; ningún ALTER TABLE "tenants". "FORCE" vuelve sobre el mismo
-- ACCESS EXCLUSIVE.
--
-- row_security = off y NO FORCE durante el relleno (DX-113/DX-134): en
-- producción el owner no es superusuario ni BYPASSRLS; con FORCE vería 0
-- sedes y el relleno (y su comprobación) no harían nada en silencio. FORCE
-- se restaura en esta misma transacción. lock_timeout 10 s: si una
-- transacción larga retiene `locations`, falla limpia y se reintenta el
-- deploy. Si esta migración falla, la API nueva no se despliega hasta que se
-- reintente con éxito.
--
-- Ninguna sentencia inserta en `locations`, así que el trigger de calendario
-- de DX-316 no se dispara. Sin trigger UTC (DX-226): no hay columnas de
-- fecha. Grants: no aplica.

SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';

ALTER TABLE "locations" NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  unmapped bigint;
  wrong bigint;
BEGIN
  SELECT count(*) INTO unmapped
    FROM "locations" l
   WHERE l."deletedAt" IS NULL
     AND l."country"::text NOT IN ('CO', 'ES');
  IF unmapped > 0 THEN
    RAISE EXCEPTION 'dx324: sede viva con país sin regla de receta (% sedes)', unmapped;
  END IF;

  -- Relleno: por clínica, a partir de sus sedes vivas. Sin sedes vivas,
  -- los valores de plataforma.
  WITH expected AS (
    SELECT t."id",
           coalesce(bool_or(l."country"::text = 'CO'), false) AS hc,
           count(l."id") > 0 AS words,
           coalesce(min(CASE l."country"::text WHEN 'CO' THEN 30 WHEN 'ES' THEN 10 END), 30) AS days
      FROM "tenants" t
      LEFT JOIN "locations" l
        ON l."tenantId" = t."id" AND l."deletedAt" IS NULL
     GROUP BY t."id"
  )
  UPDATE "tenants" t
     SET "prescriptionRequireClinicalRecordNumber" = e.hc,
         "prescriptionPrintQuantityInWords" = e.words,
         "prescriptionValidityDays" = e.days
    FROM expected e
   WHERE t."id" = e."id"
     AND (t."prescriptionRequireClinicalRecordNumber" IS DISTINCT FROM e.hc
          OR t."prescriptionPrintQuantityInWords" IS DISTINCT FROM e.words
          OR t."prescriptionValidityDays" IS DISTINCT FROM e.days);

  -- Comprobación, contada aparte: con alguna sede viva CO, HC exigido; con
  -- alguna sede viva, letras; validez 10 si alguna sede viva es ES y 30 si
  -- no. count(l."id") y coalesce: una clínica sin sedes vivas cuenta como
  -- «sin sedes», no como una fila con NULL.
  SELECT count(*) INTO wrong
    FROM "tenants" t
    JOIN (
      SELECT t2."id",
             coalesce(bool_or(l."country"::text = 'CO'), false) AS has_co,
             coalesce(bool_or(l."country"::text = 'ES'), false) AS has_es,
             count(l."id") AS live
        FROM "tenants" t2
        LEFT JOIN "locations" l
          ON l."tenantId" = t2."id" AND l."deletedAt" IS NULL
       GROUP BY t2."id"
    ) s ON s."id" = t."id"
   WHERE t."prescriptionRequireClinicalRecordNumber" <> s.has_co
      OR t."prescriptionPrintQuantityInWords" <> (s.live > 0)
      OR t."prescriptionValidityDays" <> (CASE WHEN s.has_es THEN 10 ELSE 30 END);
  IF wrong > 0 THEN
    RAISE EXCEPTION 'dx324: % clínica(s) sin los ajustes de receta que aplicaban tras el relleno', wrong;
  END IF;
END
$$;

ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;
