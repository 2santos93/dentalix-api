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
-- ella aborta con un error claro. El nombre `dentalix_app` es fijo: lo citan
-- las migraciones (GRANT EXECUTE … TO dentalix_app, REVOKE … FROM dentalix_app).
\set ON_ERROR_STOP on

\if :{?app_password}
\else
  \set app_password ''
\endif

SELECT CASE
  WHEN :'app_password' = '' THEN format(
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
