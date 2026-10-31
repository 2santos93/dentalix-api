-- DX-113: rol de la app para un Postgres gestionado (RDS, Cloud SQL…), donde el
-- owner de las migraciones NO es superusuario ni tiene BYPASSRLS.
--
-- Se ejecuta CONECTADO COMO EL OWNER (el rol de DIRECT_URL), en la base de la
-- app y antes de la primera `prisma migrate deploy`:
--
--   psql "$DIRECT_URL_SIN_SCHEMA" -v ON_ERROR_STOP=1 \
--        -v app_password="$(openssl rand -hex 24)" \
--        -f docker/prod/create-app-role.sql
--
-- Requisitos del owner: LOGIN y CREATEROLE, dueño de la base (CREATE en la base
-- para las extensiones trusted) y del esquema `public` (en PG15+ el dueño de la
-- base lo es vía pg_database_owner). Ver README, «Despliegue: roles de la BD».
--
-- Idempotente (DX-134): si `dentalix_app` ya existe (es un rol del CLÚSTER:
-- otra base del mismo servidor, o una ejecución anterior) no hace falta
-- `-v app_password` y no cambia su contraseña aunque se pase; sí comprueba que
-- no salte la RLS. Si no existe, la contraseña es obligatoria y no vacía: sin
-- ella (o con solo espacios) aborta con un error claro. El nombre
-- `dentalix_app` es fijo: lo citan las migraciones (GRANT EXECUTE … TO
-- dentalix_app, REVOKE … FROM dentalix_app).
\set ON_ERROR_STOP on

-- DX-134: un owner por clúster. dentalix_patient_search,
-- dentalix_email_dispatcher y dentalix_membership_lookup (DX-143) son roles
-- del CLÚSTER que crean las migraciones, y ADMIN OPTION sobre ellos equivale a
-- poder darse SET: quien la tenga lee `patients`, `email_outbox` y
-- `clinic_memberships` de TODAS las bases del clúster sin RLS de clínica. Antes de crear nada (y de migrar), se aborta si ya tienen otro
-- miembro que el owner actual, o si el owner actual no podrá traspasarles las
-- funciones (sin ADMIN OPTION). Ver README, «Despliegue: roles de la BD».
DO $$
DECLARE
  role_name text;
  others text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['dentalix_patient_search', 'dentalix_email_dispatcher', 'dentalix_membership_lookup'] LOOP
    CONTINUE WHEN to_regrole(role_name) IS NULL;
    SELECT string_agg(DISTINCT u.rolname, ', ' ORDER BY u.rolname) INTO others
      FROM pg_auth_members m JOIN pg_roles u ON u.oid = m.member
     WHERE m.roleid = to_regrole(role_name) AND u.rolname <> current_user;
    IF others IS NOT NULL THEN
      RAISE EXCEPTION 'Este clúster ya tiene el rol % de otro owner (miembros: %). Un owner por clúster: migra esta base con ese owner o usa un clúster distinto (README, «Despliegue: roles de la BD»). No se ha creado nada.', role_name, others;
    END IF;
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
       AND NOT EXISTS (SELECT 1 FROM pg_auth_members m
                        WHERE m.roleid = to_regrole(role_name)
                          AND m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
                          AND m.admin_option) THEN
      RAISE EXCEPTION 'El rol % ya existe en el clúster y % no tiene ADMIN OPTION sobre él (lo creó otro rol, p. ej. un superusuario). Si este clúster es solo de este owner, un admin del clúster debe ejecutar antes: GRANT dentalix_patient_search, dentalix_email_dispatcher, dentalix_membership_lookup TO % WITH ADMIN OPTION, INHERIT FALSE, SET FALSE. Si ya lo usa otro owner, usa ese owner o un clúster distinto (README, «Despliegue: roles de la BD»). No se ha creado nada.', role_name, current_user, quote_ident(current_user);
    END IF;
  END LOOP;
END
$$;

\if :{?app_password}
\else
  \set app_password ''
\endif

SELECT CASE
  WHEN btrim(:'app_password') = '' THEN format(
    'DO $e$ BEGIN RAISE EXCEPTION %L; END $e$',
    'El rol dentalix_app no existe: pasa su contraseña con -v app_password="$(openssl rand -hex 24)" (README, «Despliegue: roles de la BD»).')
  ELSE format(
    'CREATE ROLE dentalix_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
    :'app_password')
  END
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app')
\gexec

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app'
              AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN
    RAISE EXCEPTION 'dentalix_app no puede ser SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB ni REPLICATION: con eso se saltaría la RLS o podría escalar.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
                AND pg_get_userbyid(c.relowner) = 'dentalix_app') THEN
    RAISE EXCEPTION 'dentalix_app es dueño de tablas de public: con eso se saltaría la RLS sin FORCE.';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE :"DBNAME" TO dentalix_app;
GRANT USAGE ON SCHEMA public TO dentalix_app;
-- Tablas y secuencias que creen las migraciones (las crea el rol actual, el
-- owner): se conceden solas a la app. Sin FOR ROLE: aplica al rol que ejecuta
-- este script, que es el que migra.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dentalix_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO dentalix_app;
-- Por si el script se ejecuta sobre una base ya migrada (no-op en una vacía).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dentalix_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dentalix_app;

-- DX-431 (OPS-012): topes de la sesión de la app, para que una sentencia o una
-- transacción colgada no retenga su conexión del pool:
--   statement_timeout 15 s: corta una sentencia (la API responde 503
--     STATEMENT_TIMEOUT).
--   idle_in_transaction_session_timeout 150 s: cierra la sesión que deja una
--     transacción abierta sin hacer nada. Mayor que la transacción más larga
--     que permite el código (120 s: LONG_TX de la importación de pacientes,
--     DX-107, y el máximo de TENANT_TX_TIMEOUT_MS), para no cortar nunca una
--     transacción viva de la API: Prisma ya las deshace antes. Recoge las que
--     quedan abiertas fuera de su control (un proceso caído, un psql manual).
-- Por rol: valen para toda conexión NUEVA de dentalix_app, también a través
-- de PgBouncer; las conexiones ya abiertas siguen con los valores anteriores
-- hasta reiniciar la API (y PgBouncer). Idempotente: se fijan siempre a
-- estos valores. El owner puede si creó el rol (CREATEROLE le da ADMIN
-- OPTION); si lo creó otro (p. ej. un superusuario) solo avisa, con lo que
-- tiene que ejecutar un admin.
DO $$
BEGIN
  ALTER ROLE dentalix_app SET statement_timeout = '15s';
  ALTER ROLE dentalix_app SET idle_in_transaction_session_timeout = '150s';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'DX-431: % no puede fijar los timeouts de dentalix_app (no tiene ADMIN OPTION sobre el rol). Un admin del clúster debe ejecutar: ALTER ROLE dentalix_app SET statement_timeout = ''15s''; ALTER ROLE dentalix_app SET idle_in_transaction_session_timeout = ''150s'';', current_user;
END
$$;

-- DX-236: repetir el bootstrap sobre una base migrada no puede reabrir DML
-- sobre referencia global. En una base nueva las crea/revoca la migración.
DO $$
DECLARE
  reference_table text;
BEGIN
  FOREACH reference_table IN ARRAY ARRAY['icd10_codes', 'currencies', 'countries', 'cities'] LOOP
    IF pg_catalog.to_regclass('public.' || reference_table) IS NOT NULL THEN
      EXECUTE pg_catalog.format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.%I FROM dentalix_app', reference_table);
    END IF;
  END LOOP;
END;
$$;

-- Las funciones del despachador de email (email_outbox_*: reclamar, cerrar,
-- encolar de plataforma con su tope y purgar, DX-088/DX-113/DX-144) las
-- concede a dentalix_app cada migración, y solo si el rol ya existía. Si esta
-- base ya estaba migrada sin él, avisa de cuáles le faltan: sin ellas no sale
-- ningún email y la API no arranca en producción (README, «Email
-- transaccional»).
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.proname) INTO missing
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('email_outbox_claim', 'email_outbox_settle',
                       'email_outbox_enqueue_platform_capped',
                       'email_outbox_platform_allowed',
                       'email_outbox_purge_platform')
     AND NOT has_function_privilege('dentalix_app', p.oid, 'EXECUTE');
  IF missing IS NOT NULL THEN
    RAISE WARNING 'dentalix_app no puede ejecutar: %. Concédeselo como el dueño de las funciones (dentalix_email_dispatcher; README, «Email transaccional»).', missing;
  END IF;
END
$$;
