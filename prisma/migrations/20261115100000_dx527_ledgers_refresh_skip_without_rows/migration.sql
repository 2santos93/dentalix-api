-- DX-527: el refresco de cartera no calcula la cartera de quien no tiene fila.
--
-- `patient_ledgers_refresh(tenants, patients)` corre en el trigger de sentencia
-- de `patients`. Su última sentencia calcula la cartera completa (planes,
-- abonos, saldos migrados… `patient_ledgers_compute()`, un LATERAL por tabla y
-- paciente) de TODOS los ids recibidos y solo después la cruza con
-- `patient_ledgers`, de modo que a quien no tiene fila el cálculo se le tira.
-- Un paciente sin plan ni saldo migrado (todos los recién importados) nunca
-- tiene fila: deshacer un lote de 10.000 (10 sentencias de 1.000) calculaba
-- 10.000 carteras para no escribir ninguna, y su coste dependía del orden de
-- join que eligiera el planificador con las estadísticas del momento (el
-- e2e de la web tardaba 16–23 s en el primer intento y 0,8 s al reintentar,
-- con las estadísticas ya refrescadas; ver DX-294 para el mismo síntoma por
-- el plan genérico).
--
-- Ahora, tras bloquear las filas, se queda solo con los ids que SÍ tienen fila
-- en `patient_ledgers` (ya bloqueadas) y, si no queda ninguno, no calcula
-- nada. El resultado es el mismo: el UPDATE solo tocaba filas existentes. El
-- cuerpo es el de la versión anterior salvo ese filtro; conserva los dos SET
-- (`search_path` y `plan_cache_mode`, que vigila
-- test/patient-imports-undo-10k.int-spec.ts: un CREATE OR REPLACE sin ellos
-- los quita).
--
-- Vuelta atrás: volver a aplicar el cuerpo de
-- 20261106130002_dx253_patient_credit (última definición anterior) con
-- `SET plan_cache_mode = force_custom_plan`.

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
  SELECT pg_catalog.count(*)
    INTO visible
    FROM (SELECT 1
            FROM public."patients" pa
            JOIN (SELECT DISTINCT k.t, k.p
                    FROM ROWS FROM (pg_catalog.unnest(p_tenants), pg_catalog.unnest(p_patients)) AS k(t, p)) k
              ON pa."tenantId" = k.t AND pa."id" = k.p
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
            JOIN (SELECT DISTINCT k.t, k.p
                    FROM ROWS FROM (pg_catalog.unnest(p_tenants), pg_catalog.unnest(p_patients)) AS k(t, p)) k
              ON l."tenantId" = k.t AND l."patientId" = k.p
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
      FROM (SELECT DISTINCT k.t, k.p
              FROM ROWS FROM (pg_catalog.unnest(with_row_t), pg_catalog.unnest(with_row_p)) AS k(t, p)) k
      JOIN public."patient_ledgers_compute"() c
        ON c."tenantId" = k.t AND c."patientId" = k.p
     WHERE l."tenantId" = k.t AND l."patientId" = k.p;
  END IF;

  PERFORM pg_catalog.set_config('dentalix.ledgers_refresh', '', true);
END;
$function$;
