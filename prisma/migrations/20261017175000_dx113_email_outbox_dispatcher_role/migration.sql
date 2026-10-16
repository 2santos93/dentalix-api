-- DX-113: el despachador de email deja de depender de que el owner de las
-- migraciones se salte la RLS. En un Postgres gestionado (RDS, Cloud SQL…) el
-- owner no es superusuario ni tiene BYPASSRLS: las funciones de
-- 20261017120000_email_outbox, suyas y con `SET row_security = off`, fallaban
-- con "query would be affected by row-level security policy" y en producción
-- la API no arrancaba (comprobación D4 del despachador).
--
-- Mismo patrón que la búsqueda de pacientes (DX-043,
-- docs/adr/0001-busqueda-pacientes-rls.md):
--   dentalix_email_dispatcher  rol NOLOGIN NOINHERIT, SIN BYPASSRLS, dueño de
--                              email_outbox_claim/_settle/_enqueue_platform.
--                              Privilegios mínimos: USAGE del esquema y
--                              SELECT/INSERT/UPDATE de email_outbox (sin
--                              DELETE). Lo que le deja ver las filas de todas
--                              las clínicas y las de plataforma es la política
--                              PERMISIVA de abajo, que solo existe para él.
--   Las funciones pierden `row_security = off`: con la política el rol ve
--   todas las filas, y con `off` fallarían igualmente (sigue sujeto a la RLS).
--   No cambian su cuerpo, su firma, su search_path ni sus GRANT (EXECUTE solo
--   para dentalix_app; PUBLIC sigue sin él).
--
-- Requisitos del rol que migra: owner de la tabla y de las funciones y
-- CREATEROLE (no hace falta superusuario ni BYPASSRLS), como en DX-043.
-- Compatible hacia atrás: el código anterior llama a las mismas funciones.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Rol dueño. Los roles son del CLÚSTER: si ya existe (otra base del mismo
--    servidor) se reutiliza SOLO con exactamente los atributos esperados y sin
--    más miembros que el propio migrador; si no, se aborta (un miembro con SET
--    podría reemplazar las funciones o leer email_outbox sin RLS).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname = 'dentalix_email_dispatcher';
  IF NOT FOUND THEN
    CREATE ROLE dentalix_email_dispatcher NOLOGIN NOINHERIT;
  ELSIF r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole
        OR r.rolcreatedb OR r.rolreplication THEN
    RAISE EXCEPTION 'El rol dentalix_email_dispatcher ya existe con atributos inesperados (LOGIN, SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB o REPLICATION). Revísalo a mano antes de migrar.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m
              WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'dentalix_email_dispatcher')
                AND m.member <> (SELECT oid FROM pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'El rol dentalix_email_dispatcher tiene miembros inesperados (pg_auth_members). Revísalo a mano antes de migrar.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m
              WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'dentalix_email_dispatcher')) THEN
    RAISE EXCEPTION 'El rol dentalix_email_dispatcher es miembro de otros roles. Revísalo a mano antes de migrar.';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO dentalix_email_dispatcher;
GRANT SELECT, INSERT, UPDATE ON "email_outbox" TO dentalix_email_dispatcher;

-- Permisiva y solo para este rol: para él queda `tenant_isolation OR true`.
-- Para dentalix_app (y cualquier otro rol) no cambia nada.
CREATE POLICY "email_outbox_dispatcher" ON "email_outbox"
  AS PERMISSIVE FOR ALL TO dentalix_email_dispatcher
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 2. Funciones: sin row_security = off y traspasadas al rol. ALTER ... OWNER
--    exige poder hacer SET ROLE al nuevo dueño y que este tenga CREATE en el
--    esquema: ambas cosas se conceden solo para el traspaso.
-- ---------------------------------------------------------------------------
ALTER FUNCTION email_outbox_claim(integer, integer) RESET row_security;
ALTER FUNCTION email_outbox_settle(uuid, integer, "EmailOutboxStatus", timestamp(3), text) RESET row_security;
ALTER FUNCTION email_outbox_enqueue_platform("EmailTemplate", text, text, bytea, uuid) RESET row_security;

GRANT dentalix_email_dispatcher TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;
GRANT CREATE ON SCHEMA public TO dentalix_email_dispatcher;
ALTER FUNCTION email_outbox_claim(integer, integer) OWNER TO dentalix_email_dispatcher;
ALTER FUNCTION email_outbox_settle(uuid, integer, "EmailOutboxStatus", timestamp(3), text) OWNER TO dentalix_email_dispatcher;
ALTER FUNCTION email_outbox_enqueue_platform("EmailTemplate", text, text, bytea, uuid) OWNER TO dentalix_email_dispatcher;
REVOKE CREATE ON SCHEMA public FROM dentalix_email_dispatcher;
REVOKE dentalix_email_dispatcher FROM CURRENT_USER;
