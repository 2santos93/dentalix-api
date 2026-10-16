-- DX-043 (T-BD-2; DB-004, DB-005, DB-006, DB-017): búsqueda de pacientes
-- indexable con RLS e índices de pacientes, agenda y dashboard.
-- Decisión y alternativas descartadas: docs/adr/0001-busqueda-pacientes-rls.md.
--
-- Cambios:
--   pg_trgm                       extensión (trusted desde PG13; unaccent ya
--                                 estaba, 20260729000000_enable_unaccent).
--   dx_search_normalize(text)     normalización IMMUTABLE: sin tildes,
--                                 minúsculas, espacios colapsados.
--   patients.search_text          columna GENERADA (STORED) con nombre,
--                                 apellido y documento normalizados.
--   patients_search_text_trgm_live_idx  GIN trigram parcial (vivos).
--   patients_tenant_created_live_idx    (tenantId, createdAt DESC, id DESC)
--                                 parcial (vivos): página del listado sin Sort.
--   dentalix_patient_search       rol NOLOGIN + BYPASSRLS, SELECT solo de las
--                                 columnas que usa la búsqueda. Dueño de:
--   dx_patient_search_ids / dx_patient_search_count  SECURITY DEFINER con
--                                 search_path fijo; filtran por el tenant del
--                                 CONTEXTO (app.current_tenant), nunca por un
--                                 parámetro. EXECUTE solo para dentalix_app.
--   appointments_tenant_location_start_idx (tenantId, locationId, start):
--                                 agenda por sede/semana y lado hijo de la FK
--                                 compuesta a locations (por eso NO es parcial).
--   appointments_tenant_start_live_idx (tenantId, start) parcial (vivas):
--                                 agenda consolidada y «próximas citas».
--   DROP de índices redundantes   cada uno es PREFIJO EXACTO de otro btree no
--                                 parcial de la misma tabla (DB-017), que cubre
--                                 las mismas búsquedas y el lado hijo de las FK:
--     patients_tenantId_idx                   ⊂ patients_tenant_id_key (tenantId, id)
--     locations_tenantId_idx                  ⊂ locations_tenant_id_key (tenantId, id)
--     inventory_items_tenantId_idx            ⊂ inventory_items_tenant_id_key (tenantId, id)
--     location_schedules_tenantId_idx         ⊂ location_schedules_tenant_id_key (tenantId, id)
--     tooth_records_tenantId_patientId_idx    ⊂ tooth_records_tenantId_patientId_toothNumber_idx
--     appointments_tenantId_locationId_idx    ⊂ appointments_tenant_location_start_idx (nuevo)
--
-- Compatible hacia atrás: no cambia ni borra datos ni columnas existentes. La
-- columna generada se calcula sola (el código anterior no la escribe ni la
-- lee). Quitar un índice redundante no cambia ningún resultado.
--
-- Bloqueos: ADD COLUMN ... GENERATED STORED reescribe `patients` (ACCESS
-- EXCLUSIVE durante la reescritura; con 50k filas, menos de un segundo). Los
-- CREATE INDEX no son CONCURRENTLY porque Prisma corre cada migración en una
-- transacción; con los volúmenes actuales es cuestión de segundos.
--
-- Requisitos del rol que migra: crear un rol con BYPASSRLS exige superusuario
-- (en PG16, o CREATEROLE + BYPASSRLS propio). Es el rol owner "dentalix", el
-- mismo que ya hace falta para las migraciones con `row_security = off`.

-- ---------------------------------------------------------------------------
-- 1. Extensiones
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ---------------------------------------------------------------------------
-- 2. Normalización IMMUTABLE.
--    `unaccent(text)` es STABLE (depende del search_path y del diccionario), así
--    que no puede ir en una columna generada. La forma de dos argumentos con el
--    diccionario y la función calificados por esquema no depende del
--    search_path; se declara IMMUTABLE asumiendo que `unaccent.rules` no cambia
--    (si cambiara: recalcular con `UPDATE patients SET "firstName" = "firstName"`
--    y REINDEX del índice trigram). SQL de una sola sentencia y sin SET: el
--    planner la puede inlinear.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx_search_normalize(input text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT pg_catalog.btrim(pg_catalog.regexp_replace(
           pg_catalog.lower(public.unaccent('public.unaccent'::regdictionary, input)),
           '\s+', ' ', 'g'))
$$;

-- ---------------------------------------------------------------------------
-- 3. Columna generada + índices de pacientes
-- ---------------------------------------------------------------------------
ALTER TABLE "patients"
  ADD COLUMN "search_text" TEXT GENERATED ALWAYS AS (
    public.dx_search_normalize(
      "firstName" || ' ' || "lastName" || ' ' || COALESCE("docNumber", '')
    )
  ) STORED;

CREATE INDEX "patients_search_text_trgm_live_idx"
  ON "patients" USING gin ("search_text" gin_trgm_ops)
  WHERE "deletedAt" IS NULL;

CREATE INDEX "patients_tenant_created_live_idx"
  ON "patients" ("tenantId", "createdAt" DESC, "id" DESC)
  WHERE "deletedAt" IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Rol dueño de la búsqueda.
--    Los roles son del CLÚSTER (no de la base): se crea solo si no existe y se
--    le fijan los atributos siempre, por si alguien lo hubiera creado distinto.
--    NOLOGIN: nadie puede conectarse como él; solo "presta" BYPASSRLS a las dos
--    funciones de abajo. Privilegios mínimos: USAGE del esquema y SELECT de las
--    cinco columnas que lee la búsqueda (ni nombres en claro ni datos clínicos).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_patient_search') THEN
    CREATE ROLE dentalix_patient_search NOLOGIN BYPASSRLS;
  END IF;
END
$$;
ALTER ROLE dentalix_patient_search NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS;

GRANT USAGE ON SCHEMA public TO dentalix_patient_search;
GRANT SELECT ("id", "tenantId", "search_text", "createdAt", "deletedAt")
  ON "patients" TO dentalix_patient_search;

-- ---------------------------------------------------------------------------
-- 5. Búsqueda SECURITY DEFINER.
--    Por qué hace falta: bajo RLS, Postgres no usa como condición de índice
--    ninguna cláusula cuyo operador no sea LEAKPROOF (`~~`/`~~*` no lo son), así
--    que con la política activa el índice trigram nunca se usa. Estas funciones
--    corren como un rol con BYPASSRLS y aplican ellas mismas el MISMO predicado
--    que la política (`tenantId = app.current_tenant`), leído del contexto de
--    la transacción que fija `PrismaService.runWithTenant`. Sin tenant en el
--    contexto, NULL = nada. Devuelven solo ids (y un conteo): la fila completa
--    se lee después con la RLS normal.
--    El término se normaliza igual que la columna y se escapan \ % _ para que
--    sean literales. EXECUTE dinámico: plan con el patrón real cada vez (un
--    plan genérico no sabría si el patrón es selectivo).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx_patient_search_ids(p_query text, p_limit integer, p_offset integer)
  RETURNS TABLE (id uuid)
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := NULLIF(pg_catalog.current_setting('app.current_tenant', true), '')::uuid;
  v_pattern text := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
      public.dx_search_normalize(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%';
BEGIN
  IF v_tenant IS NULL OR p_query IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE
    'SELECT p.id FROM public.patients p
      WHERE p."tenantId" = $1
        AND p."deletedAt" IS NULL
        AND p.search_text LIKE $2
      ORDER BY p."createdAt" DESC, p.id DESC
      LIMIT $3 OFFSET $4'
    USING v_tenant, v_pattern, GREATEST(p_limit, 0), GREATEST(p_offset, 0);
END
$$;

CREATE FUNCTION public.dx_patient_search_count(p_query text)
  RETURNS bigint
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := NULLIF(pg_catalog.current_setting('app.current_tenant', true), '')::uuid;
  v_pattern text := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
      public.dx_search_normalize(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_total bigint;
BEGIN
  IF v_tenant IS NULL OR p_query IS NULL THEN
    RETURN 0;
  END IF;
  EXECUTE
    'SELECT count(*) FROM public.patients p
      WHERE p."tenantId" = $1
        AND p."deletedAt" IS NULL
        AND p.search_text LIKE $2'
    INTO v_total
    USING v_tenant, v_pattern;
  RETURN v_total;
END
$$;

ALTER FUNCTION public.dx_patient_search_ids(text, integer, integer) OWNER TO dentalix_patient_search;
ALTER FUNCTION public.dx_patient_search_count(text) OWNER TO dentalix_patient_search;
REVOKE ALL ON FUNCTION public.dx_patient_search_ids(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dx_patient_search_count(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dx_patient_search_ids(text, integer, integer) TO dentalix_app;
GRANT EXECUTE ON FUNCTION public.dx_patient_search_count(text) TO dentalix_app;

-- ---------------------------------------------------------------------------
-- 6. Índices de citas (DB-006)
-- ---------------------------------------------------------------------------
CREATE INDEX "appointments_tenant_location_start_idx"
  ON "appointments" ("tenantId", "locationId", "start");

CREATE INDEX "appointments_tenant_start_live_idx"
  ON "appointments" ("tenantId", "start")
  WHERE "deletedAt" IS NULL;

-- ---------------------------------------------------------------------------
-- 7. Índices redundantes (DB-017). Solo los que son prefijo exacto de otro
--    btree NO parcial de la misma tabla (comprobado en pg_index; ver la
--    cabecera). `payments_tenantId_locationId_idx` se queda: lo cubre un índice
--    PARCIAL, que no sirve para las filas retiradas ni para la FK.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS "patients_tenantId_idx";
DROP INDEX IF EXISTS "locations_tenantId_idx";
DROP INDEX IF EXISTS "inventory_items_tenantId_idx";
DROP INDEX IF EXISTS "location_schedules_tenantId_idx";
DROP INDEX IF EXISTS "tooth_records_tenantId_patientId_idx";
DROP INDEX IF EXISTS "appointments_tenantId_locationId_idx";
