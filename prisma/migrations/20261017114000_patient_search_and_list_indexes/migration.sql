-- DX-043 (T-BD-2; DB-004, DB-005, DB-006, DB-017): búsqueda de pacientes
-- indexable con RLS. Decisión y alternativas: docs/adr/0001-busqueda-pacientes-rls.md.
--
-- Esta migración (una transacción) crea:
--   pg_trgm, btree_gin            extensiones (trusted desde PG13; unaccent ya
--                                 estaba, 20260729000000_enable_unaccent).
--   dx_search_normalize(text)     normalización IMMUTABLE: sin tildes,
--                                 minúsculas, espacios colapsados.
--   patients.search_text          columna GENERADA (STORED) con nombre,
--                                 apellido y documento normalizados.
--   dentalix_patient_search       rol NOLOGIN, SIN BYPASSRLS, SELECT solo de las
--                                 columnas que usa la búsqueda, y una política
--                                 FOR SELECT TO ese rol USING (true). Es dueño de:
--   dx_patient_search_ids / dx_patient_search_count  SECURITY DEFINER con
--                                 search_path fijo; filtran por el tenant del
--                                 CONTEXTO (app.current_tenant), nunca por un
--                                 parámetro. EXECUTE solo para dentalix_app.
--
-- Los índices van en migraciones aparte, una sentencia CONCURRENTLY por
-- fichero (Prisma las ejecuta fuera de transacción), para no bloquear
-- escrituras: 20261017114100..110300 los crean y 20261017114400..110900
-- retiran los redundantes (DB-017).
--
-- Bloqueos de ESTA migración: ADD COLUMN ... GENERATED STORED REESCRIBE la
-- tabla `patients` y reconstruye sus índices con ACCESS EXCLUSIVE hasta el
-- COMMIT (lecturas y escrituras de pacientes en espera). Medido: < 1 s con 60k
-- filas; en producción, del orden de 1-2 s por cada 100k pacientes: aplicarla
-- en ventana de poco tráfico. `lock_timeout` hace que, si una transacción
-- larga tiene `patients` tomada, la migración falle (y se reintente) en vez
-- de dejar a toda la API en cola detrás de ella.
--
-- Compatible hacia atrás: no cambia ni borra datos ni columnas existentes; el
-- código anterior no escribe ni lee la columna generada.
--
-- Requisitos del rol que migra: owner de las tablas y CREATEROLE (no hace
-- falta superusuario ni BYPASSRLS). Para traspasar las funciones al rol de
-- búsqueda se concede a sí mismo la membresía con SET y el rol recibe CREATE
-- en `public` solo durante el traspaso; ambas cosas se revocan al final.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Extensiones
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
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
-- 3. Columna generada (reescribe `patients`, ver cabecera)
-- ---------------------------------------------------------------------------
ALTER TABLE "patients"
  ADD COLUMN "search_text" TEXT GENERATED ALWAYS AS (
    public.dx_search_normalize(
      "firstName" || ' ' || "lastName" || ' ' || COALESCE("docNumber", '')
    )
  ) STORED;

-- ---------------------------------------------------------------------------
-- 4. Rol dueño de la búsqueda.
--    Los roles son del CLÚSTER: si ya existe (otra base del mismo servidor), se
--    reutiliza SOLO si tiene exactamente los atributos esperados y nadie más
--    que el propio migrador es miembro suyo; si no, se aborta (un miembro con
--    SET podría reemplazar las funciones o leer `patients` sin RLS).
--    Sin BYPASSRLS: lo que le deja leer `patients` es la
--    política de abajo, que solo existe para él y solo para SELECT. Privilegios
--    mínimos: USAGE del esquema y SELECT de las cinco columnas que lee la
--    búsqueda (ni nombres en claro ni datos clínicos).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname = 'dentalix_patient_search';
  IF NOT FOUND THEN
    CREATE ROLE dentalix_patient_search NOLOGIN NOINHERIT;
  ELSIF r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole
        OR r.rolcreatedb OR r.rolreplication THEN
    RAISE EXCEPTION 'El rol dentalix_patient_search ya existe con atributos inesperados (LOGIN, SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB o REPLICATION). Revísalo a mano antes de migrar.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m
              WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'dentalix_patient_search')
                AND m.member <> (SELECT oid FROM pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'El rol dentalix_patient_search tiene miembros inesperados (pg_auth_members). Revísalo a mano antes de migrar.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m
              WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'dentalix_patient_search')) THEN
    RAISE EXCEPTION 'El rol dentalix_patient_search es miembro de otros roles. Revísalo a mano antes de migrar.';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO dentalix_patient_search;
GRANT SELECT ("id", "tenantId", "search_text", "createdAt", "deletedAt")
  ON "patients" TO dentalix_patient_search;

-- Política PERMISIVA solo para este rol y solo de lectura. Las permisivas se
-- combinan con OR: para él queda `tenant_isolation OR true` = true, así que no
-- hay "security qual" y el LIKE puede ser condición de índice. Para
-- dentalix_app (y cualquier otro rol) no cambia nada. El aislamiento lo pone
-- el WHERE "tenantId" = app.current_tenant de las funciones.
CREATE POLICY "patient_search_definer" ON "patients"
  AS PERMISSIVE FOR SELECT TO dentalix_patient_search USING (true);

-- ---------------------------------------------------------------------------
-- 5. Búsqueda SECURITY DEFINER.
--    Por qué hace falta: bajo RLS, Postgres no usa como condición de índice
--    ninguna cláusula cuyo operador no sea LEAKPROOF (`~~`/`~~*` no lo son), así
--    que con la política activa el índice trigram nunca se usa. Estas funciones
--    corren como dentalix_patient_search (política USING (true)) y aplican ellas
--    mismas el MISMO predicado
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
  -- Menos de 2 caracteres no da trigramas útiles: el repositorio usa el
  -- camino normal bajo RLS. Aquí, nada (defensa en profundidad).
  IF v_tenant IS NULL OR p_query IS NULL
     OR pg_catalog.length(public.dx_search_normalize(p_query)) < 2 THEN
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
  IF v_tenant IS NULL OR p_query IS NULL
     OR pg_catalog.length(public.dx_search_normalize(p_query)) < 2 THEN
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

-- Permisos ANTES del traspaso: después, un migrador que no sea superusuario
-- ya no es dueño y su REVOKE/GRANT no tendría efecto (solo un WARNING).
REVOKE ALL ON FUNCTION public.dx_patient_search_ids(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dx_patient_search_count(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dx_patient_search_ids(text, integer, integer) TO dentalix_app;
GRANT EXECUTE ON FUNCTION public.dx_patient_search_count(text) TO dentalix_app;

-- Traspaso al rol de búsqueda: ALTER ... OWNER exige poder hacer SET ROLE al
-- nuevo dueño y que este tenga CREATE en el esquema. Ambas cosas se conceden
-- solo para el traspaso y se revocan acto seguido.
GRANT dentalix_patient_search TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;
GRANT CREATE ON SCHEMA public TO dentalix_patient_search;
ALTER FUNCTION public.dx_patient_search_ids(text, integer, integer) OWNER TO dentalix_patient_search;
ALTER FUNCTION public.dx_patient_search_count(text) OWNER TO dentalix_patient_search;
REVOKE CREATE ON SCHEMA public FROM dentalix_patient_search;
REVOKE dentalix_patient_search FROM CURRENT_USER;
