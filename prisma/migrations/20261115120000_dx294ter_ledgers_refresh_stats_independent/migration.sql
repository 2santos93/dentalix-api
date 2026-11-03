-- DX-294-ter: el refresco de cartera deja de depender de las estadísticas.
--
-- Deshacer un lote de 10.000 recién importados era bimodal (0,3 s o 2–4 s en
-- la int, 1 s o 16–27 s en el e2e de la web), también con los planes a medida
-- de DX-294 y el atajo de DX-527. `patient_ledgers_refresh` cruzaba los ids
-- con un `JOIN (SELECT DISTINCT … unnest …) k`; la política RLS propaga
-- `tenantId = <tenant actual>` a ese `unnest`, y el planificador le aplica la
-- selectividad por defecto: estima 5 filas para los 1.000 ids reales. Con esa
-- cifra, y con `patients` estimada en 1 fila para el tenant (estadísticas de
-- antes de importar con densidad baja: `reltuples` pequeño sobre las páginas
-- vacías de borrados anteriores), gana por 4 puntos de coste un Nested Loop
-- sobre un Materialize de TODOS los pacientes del tenant:
-- ids × pacientes comparaciones (5 millones por sentencia de 1.000). Cuando el
-- autoanalyze llega, o el VACUUM truncó esas páginas, sale la sonda por
-- índice. Esa moneda al aire es el modo lento y por eso el reintento vuela.
-- Medido en REPORT-DX-294-ter.
--
-- Ahora no hay join que estimar: cada búsqueda es un filtro `= ANY(array)`,
-- que PostgreSQL resuelve por índice o con la tabla hash de la ScalarArrayOp
-- (a medida, por eso sigue `plan_cache_mode = force_custom_plan`), con coste
-- lineal en cualquier plan. El id de un paciente es único, así que los dos
-- `= ANY` eligen las mismas filas que el join por pares. El resto del cuerpo
-- es el de 20261115100000_dx527_ledgers_refresh_skip_without_rows y conserva
-- los dos SET (los vigila test/patient-imports-undo-10k.int-spec.ts).
--
-- Vuelta atrás: volver a aplicar el cuerpo de
-- 20261115100000_dx527_ledgers_refresh_skip_without_rows.

CREATE OR REPLACE FUNCTION public.patient_ledgers_refresh(p_tenants uuid[], p_patients uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
DECLARE
  wanted integer;
  visible integer;
  with_row_t uuid[];
  with_row_p uuid[];
BEGIN
  IF p_tenants IS NULL OR pg_catalog.cardinality(p_tenants) = 0 THEN
    RETURN;
  END IF;

  -- Bloqueo por paciente, en orden, sobre su fila de `patients` (existe
  -- aunque aún no tenga fila en el resumen; ver DX-155). De paso cuenta
  -- los que ve: un refresco que no ve a los pacientes no puede recalcularlos
  -- y falla en vez de dejar sus filas viejas.
  SELECT pg_catalog.count(DISTINCT (k.t, k.p))
    INTO wanted
    FROM ROWS FROM (pg_catalog.unnest(p_tenants), pg_catalog.unnest(p_patients)) AS k(t, p);
  -- `= ANY`, no un join contra el unnest: ver la cabecera de la migración
  -- (DX-294-ter); aquí y en los dos sitios de abajo.
  SELECT pg_catalog.count(*)
    INTO visible
    FROM (SELECT 1
            FROM public."patients" pa
           WHERE pa."tenantId" = ANY (p_tenants) AND pa."id" = ANY (p_patients)
           ORDER BY pa."tenantId", pa."id"
             FOR NO KEY UPDATE OF pa) locked;
  IF visible < wanted THEN
    RAISE EXCEPTION 'patient_ledgers: no se ven % de % pacientes que hay que recalcular (¿escritura sin contexto de tenant con RLS FORCE?)',
      wanted - visible, wanted
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Marca de la transacción para la guarda: estas escrituras son de la BD.
  PERFORM pg_catalog.set_config('dentalix.ledgers_refresh', 'on', true);

  -- Fila para quien tiene algún plan o saldo migrado; en orden, como el
  -- bloqueo de abajo.
  INSERT INTO public."patient_ledgers" ("tenantId", "patientId")
  SELECT DISTINCT k.t, k.p
    FROM ROWS FROM (pg_catalog.unnest(p_tenants), pg_catalog.unnest(p_patients)) AS k(t, p)
   WHERE EXISTS (SELECT 1 FROM public."treatment_plans" tp
                  WHERE tp."tenantId" = k.t AND tp."patientId" = k.p)
      OR EXISTS (SELECT 1 FROM public."opening_balances" o
                  WHERE o."tenantId" = k.t AND o."patientId" = k.p)
   ORDER BY 1, 2
  ON CONFLICT ("tenantId", "patientId") DO NOTHING;

  -- Los ids que tienen fila (los demás no tienen nada que actualizar), con
  -- su fila bloqueada, en orden.
  SELECT pg_catalog.array_agg(locked."tenantId"), pg_catalog.array_agg(locked."patientId")
    INTO with_row_t, with_row_p
    FROM (SELECT l."tenantId", l."patientId"
            FROM public."patient_ledgers" l
           WHERE l."tenantId" = ANY (p_tenants) AND l."patientId" = ANY (p_patients)
           ORDER BY l."tenantId", l."patientId"
             FOR UPDATE OF l) locked;

  -- Sin filas que actualizar no se calcula ninguna cartera (DX-527).
  IF with_row_t IS NOT NULL THEN
    -- Sentencia aparte, después del bloqueo: en READ COMMITTED toma una foto
    -- nueva, que ya incluye lo que confirmó quien tenía el bloqueo.
    UPDATE public."patient_ledgers" l
       SET "locationId" = c."locationId",
           "owing" = c."owing",
           "ledger" = c."ledger",
           "updatedAt" = pg_catalog.timezone('UTC', pg_catalog.now())
      FROM public."patient_ledgers_compute"() c
     WHERE c."tenantId" = ANY (with_row_t) AND c."patientId" = ANY (with_row_p)
       AND l."tenantId" = c."tenantId" AND l."patientId" = c."patientId";
  END IF;

  PERFORM pg_catalog.set_config('dentalix.ledgers_refresh', '', true);
END;
$function$;
