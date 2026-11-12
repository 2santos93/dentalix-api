-- DX-015-bis (criterio de 500 ms): la sede de la última cita atendida del
-- paciente, GUARDADA en cada recall ("visitLocationId"), para que la lista de
-- recall no haga una LATERAL a appointments por cada candidato (con 60.000
-- pacientes y withinDays = 60 eso eran ~37.000 búsquedas y pasaba de 500 ms
-- en CI). La semántica no cambia (DX-089/DX-547): la sede del paciente es la
-- de su última cita COMPLETED viva (por "start" DESC, "id" DESC) o, sin
-- ninguna, la del recall ("locationId").
--
-- Derivada, la mantiene SOLO la BD (la app nunca la escribe):
--  - appointments: triggers de SENTENCIA con tablas de transición (como
--    patient_ledgers, DX-155) en INSERT, UPDATE y DELETE; solo recalculan los
--    pacientes con alguna cita COMPLETED afectada (alta, cambio de estado,
--    hora, sede, paciente o borrado lógico) y bloquean sus recalls en orden
--    de id antes de escribir. Se disparan después de los de patient_ledgers
--    (orden alfabético), que ya bloquean a esos pacientes en orden.
--  - patient_recalls: al dar de alta un recall (o cambiarlo de paciente),
--    trigger de SENTENCIA con tablas de transición; un BEFORE de fila solo
--    descarta el valor que mande el cliente (sin consultas).
-- Con la RLS de quien escribe (SECURITY INVOKER): las citas y los recalls de
-- su clínica, como el trigger de compatibilidad.
--
-- Sin FK a locations: es una caché de appointments."locationId", que ya
-- tiene la suya (RESTRICT): una sede con citas no se borra.
--
-- Relleno: 20261212090500. Índice que la incluye: 20261212090600.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "patient_recalls" ADD COLUMN "visitLocationId" UUID;

COMMENT ON COLUMN "patient_recalls"."visitLocationId" IS
  'DX-015-bis: sede de la última cita COMPLETED viva del paciente (derivada; la mantienen los triggers patient_recalls_visit_location_*). NULL si no tiene.';

-- ---------------------------------------------------------------------------
-- dx_recall_visit_location_refresh: recalcula "visitLocationId" de todos los
-- recalls de esos pacientes (pares tenant/paciente). `= ANY`, no un join
-- contra el unnest (como patient_ledgers_refresh, DX-294-ter).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx_recall_visit_location_refresh(p_tenants uuid[], p_patients uuid[])
  RETURNS void
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, public, pg_temp
  SET plan_cache_mode = 'force_custom_plan'
AS $$
DECLARE
  old_sort text := pg_catalog.current_setting('enable_sort');
  old_incremental text := pg_catalog.current_setting('enable_incremental_sort');
BEGIN
  IF p_tenants IS NULL OR pg_catalog.cardinality(p_tenants) = 0 THEN
    RETURN;
  END IF;
  -- Los recalls de esos pacientes, bloqueados en orden: dos escrituras
  -- concurrentes de citas del mismo paciente no se cruzan.
  PERFORM 1
     FROM (SELECT pr."id"
             FROM public."patient_recalls" pr
            WHERE pr."tenantId" = ANY (p_tenants)
              AND pr."patientId" = ANY (p_patients)
            ORDER BY pr."id"
              FOR NO KEY UPDATE OF pr) locked;
  -- Marca de la transacción: el BEFORE de patient_recalls no repite por fila
  -- la búsqueda que este UPDATE ya hace (ver dx_recall_visit_location_on_recall).
  PERFORM pg_catalog.set_config('dentalix.recall_visit_refresh', 'on', true);
  -- Sin join que estimar (DX-294-ter): una sola tabla filtrada con `= ANY` y
  -- la sede en una subconsulta correlacionada por el índice parcial
  -- appointments_tenant_patient_completed_idx. Con un join contra la propia
  -- patient_recalls, y sus estadísticas de antes de una carga (1 fila), el
  -- planificador puede elegir un Nested Loop recalls × recalls. Las columnas
  -- de pr llegan a la subconsulta como parámetros, no como constantes.
  --
  -- Sin sort solo en este UPDATE: el único índice que da "start" DESC, "id"
  -- DESC tras la igualdad de clínica y paciente, sin ordenar, es el parcial
  -- appointments_tenant_patient_completed_idx. Con estimaciones de 1 fila
  -- (appointments analizada vacía antes de una carga) empataba con el GiST
  -- appointments_no_overlap_per_patient + Sort, y la igualdad en ese GiST,
  -- según cómo se llenó, recorre buena parte del índice por búsqueda: un
  -- INSERT de 180.000 citas pasaba de 8 min en la int de carga (4,4 s así).
  -- El bloqueo de arriba sí ordena (por id), por eso no va en la función.
  PERFORM pg_catalog.set_config('enable_sort', 'off', true);
  PERFORM pg_catalog.set_config('enable_incremental_sort', 'off', true);
  UPDATE public."patient_recalls" pr
     SET "visitLocationId" = (
           SELECT a."locationId"
             FROM public."appointments" a
            WHERE a."tenantId" = pr."tenantId"
              AND a."patientId" = pr."patientId"
              AND a."status" = 'COMPLETED'
              AND a."deletedAt" IS NULL
            ORDER BY a."start" DESC, a."id" DESC
            LIMIT 1)
   WHERE pr."tenantId" = ANY (p_tenants)
     AND pr."patientId" = ANY (p_patients)
     AND pr."visitLocationId" IS DISTINCT FROM (
           SELECT a."locationId"
             FROM public."appointments" a
            WHERE a."tenantId" = pr."tenantId"
              AND a."patientId" = pr."patientId"
              AND a."status" = 'COMPLETED'
              AND a."deletedAt" IS NULL
            ORDER BY a."start" DESC, a."id" DESC
            LIMIT 1);
  PERFORM pg_catalog.set_config('enable_sort', old_sort, true);
  PERFORM pg_catalog.set_config('enable_incremental_sort', old_incremental, true);
  PERFORM pg_catalog.set_config('dentalix.recall_visit_refresh', '', true);
END;
$$;

COMMENT ON FUNCTION public.dx_recall_visit_location_refresh(uuid[], uuid[]) IS
  'DX-015-bis: recalcula patient_recalls."visitLocationId" de esos pacientes (triggers de appointments y el relleno).';

-- ---------------------------------------------------------------------------
-- Triggers de sentencia de appointments.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx_recall_visit_location_on_appointments()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ts uuid[];
  ps uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT pg_catalog.array_agg(k.t), pg_catalog.array_agg(k.p)
      INTO ts, ps
      FROM (SELECT DISTINCT n."tenantId" AS t, n."patientId" AS p
              FROM new_rows n
             WHERE n."status" = 'COMPLETED' AND n."deletedAt" IS NULL) k;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT pg_catalog.array_agg(k.t), pg_catalog.array_agg(k.p)
      INTO ts, ps
      FROM (SELECT DISTINCT o."tenantId" AS t, o."patientId" AS p
              FROM old_rows o
             WHERE o."status" = 'COMPLETED' AND o."deletedAt" IS NULL) k;
  ELSE
    SELECT pg_catalog.array_agg(k.t), pg_catalog.array_agg(k.p)
      INTO ts, ps
      FROM (SELECT DISTINCT x.t, x.p
              FROM new_rows n
              JOIN old_rows o ON o."id" = n."id",
                   LATERAL (VALUES (o."tenantId", o."patientId"), (n."tenantId", n."patientId")) AS x(t, p)
             WHERE (o."status" = 'COMPLETED' OR n."status" = 'COMPLETED')
               AND (o."tenantId", o."patientId", o."status", o."start", o."locationId", o."deletedAt")
                   IS DISTINCT FROM
                   (n."tenantId", n."patientId", n."status", n."start", n."locationId", n."deletedAt")) k;
  END IF;
  PERFORM public.dx_recall_visit_location_refresh(ts, ps);
  RETURN NULL;
END;
$$;

CREATE TRIGGER "patient_recalls_visit_location_insert"
  AFTER INSERT ON "appointments"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_recall_visit_location_on_appointments();
CREATE TRIGGER "patient_recalls_visit_location_update"
  AFTER UPDATE ON "appointments"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_recall_visit_location_on_appointments();
CREATE TRIGGER "patient_recalls_visit_location_delete"
  AFTER DELETE ON "appointments"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_recall_visit_location_on_appointments();

-- ---------------------------------------------------------------------------
-- patient_recalls: el alta (o el cambio de paciente) trae la suya, también
-- por conjuntos. El BEFORE de fila no consulta appointments: una búsqueda por
-- fila depende de las estadísticas (con appointments analizada vacía antes de
-- una carga, el plan a medida recorre appointments_tenant_start_live_idx
-- entera por fila, y PL/pgSQL puede dejar cacheado en la conexión un Seq Scan
-- genérico: medido en la int de carga, minutos para 15.000 recalls). Solo
-- descarta lo que mande el cliente: en un alta la deja a NULL y en un UPDATE
-- conserva la de antes (o NULL si cambia de paciente). Después, un trigger de
-- SENTENCIA llama al refresco con los pacientes afectados.
--
-- Dentro del refresco (marca de la transacción dentalix.recall_visit_refresh)
-- no hace nada: es él quien escribe. La marca la puede poner cualquier
-- sesión; solo cambia una caché de su propia clínica (RLS), como
-- dentalix.ledgers_refresh.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx_recall_visit_location_on_recall()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF coalesce(pg_catalog.current_setting('dentalix.recall_visit_refresh', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId"
     AND NEW."patientId" IS NOT DISTINCT FROM OLD."patientId" THEN
    NEW."visitLocationId" := OLD."visitLocationId";
  ELSE
    NEW."visitLocationId" := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "patient_recalls_visit_location"
  BEFORE INSERT OR UPDATE OF "tenantId", "patientId", "visitLocationId" ON "patient_recalls"
  FOR EACH ROW EXECUTE FUNCTION public.dx_recall_visit_location_on_recall();

CREATE FUNCTION public.dx_recall_visit_location_on_recalls()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  ts uuid[];
  ps uuid[];
BEGIN
  IF coalesce(pg_catalog.current_setting('dentalix.recall_visit_refresh', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT pg_catalog.array_agg(k.t), pg_catalog.array_agg(k.p)
      INTO ts, ps
      FROM (SELECT DISTINCT n."tenantId" AS t, n."patientId" AS p FROM new_rows n) k;
  ELSE
    SELECT pg_catalog.array_agg(k.t), pg_catalog.array_agg(k.p)
      INTO ts, ps
      FROM (SELECT DISTINCT n."tenantId" AS t, n."patientId" AS p
              FROM new_rows n
              JOIN old_rows o ON o."id" = n."id"
             WHERE (o."tenantId", o."patientId") IS DISTINCT FROM (n."tenantId", n."patientId")) k;
  END IF;
  PERFORM public.dx_recall_visit_location_refresh(ts, ps);
  RETURN NULL;
END;
$$;

CREATE TRIGGER "patient_recalls_visit_location_after_insert"
  AFTER INSERT ON "patient_recalls"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_recall_visit_location_on_recalls();
CREATE TRIGGER "patient_recalls_visit_location_after_update"
  AFTER UPDATE ON "patient_recalls"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.dx_recall_visit_location_on_recalls();

REVOKE ALL ON FUNCTION public.dx_recall_visit_location_refresh(uuid[], uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dx_recall_visit_location_on_appointments() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dx_recall_visit_location_on_recall() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dx_recall_visit_location_on_recalls() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app') THEN
    GRANT EXECUTE ON FUNCTION public.dx_recall_visit_location_refresh(uuid[], uuid[]) TO dentalix_app;
  END IF;
END
$$;
