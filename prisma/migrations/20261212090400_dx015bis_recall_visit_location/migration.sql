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
--  - patient_recalls: al dar de alta un recall (o cambiarlo de paciente) se
--    calcula en un BEFORE (el valor que mande el cliente se ignora).
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
  UPDATE public."patient_recalls" pr
     SET "visitLocationId" = v."locationId"
    FROM (SELECT r."id",
                 (SELECT a."locationId"
                    FROM public."appointments" a
                   WHERE a."tenantId" = r."tenantId"
                     AND a."patientId" = r."patientId"
                     AND a."status" = 'COMPLETED'
                     AND a."deletedAt" IS NULL
                   ORDER BY a."start" DESC, a."id" DESC
                   LIMIT 1) AS "locationId"
            FROM public."patient_recalls" r
           WHERE r."tenantId" = ANY (p_tenants)
             AND r."patientId" = ANY (p_patients)) v
   WHERE pr."id" = v."id"
     AND pr."visitLocationId" IS DISTINCT FROM v."locationId";
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
-- El alta de un recall (o su cambio de paciente) trae la suya.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx_recall_visit_location_on_recall()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW."visitLocationId" := (
    SELECT a."locationId"
      FROM public."appointments" a
     WHERE a."tenantId" = NEW."tenantId"
       AND a."patientId" = NEW."patientId"
       AND a."status" = 'COMPLETED'
       AND a."deletedAt" IS NULL
     ORDER BY a."start" DESC, a."id" DESC
     LIMIT 1);
  RETURN NEW;
END;
$$;

CREATE TRIGGER "patient_recalls_visit_location"
  BEFORE INSERT OR UPDATE OF "tenantId", "patientId", "visitLocationId" ON "patient_recalls"
  FOR EACH ROW EXECUTE FUNCTION public.dx_recall_visit_location_on_recall();

REVOKE ALL ON FUNCTION public.dx_recall_visit_location_refresh(uuid[], uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dx_recall_visit_location_on_appointments() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dx_recall_visit_location_on_recall() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app') THEN
    GRANT EXECUTE ON FUNCTION public.dx_recall_visit_location_refresh(uuid[], uuid[]) TO dentalix_app;
  END IF;
END
$$;
