-- DX-143 (SEC-033, defensa en profundidad): saber si un usuario tiene
-- membresías ACTIVAS en otras clínicas, para que aceptar una invitación no
-- pueda «reclamar» (contraseña nueva) una cuenta sin verificar que ya da
-- acceso a otra clínica.
--
-- `clinic_memberships` tiene RLS FORCE por tenant: desde una petición solo se
-- ven las membresías de la clínica en contexto y nada puede mirar las demás.
-- Mismo andamiaje que la búsqueda de pacientes (DX-043,
-- docs/adr/0001-busqueda-pacientes-rls.md) y el despachador de email (DX-113):
--   dentalix_membership_lookup  rol NOLOGIN NOINHERIT, SIN BYPASSRLS. Privilegios
--                               mínimos: USAGE del esquema y SELECT de tres
--                               columnas de clinic_memberships ("userId",
--                               "tenantId", "deletedAt"). Lo que le deja ver
--                               las filas de todas las clínicas es la política
--                               PERMISIVA de SELECT de abajo, solo para él.
--   dx_user_has_other_active_memberships(p_user_id, p_tenant_id) → boolean
--                               SECURITY DEFINER de ese rol, search_path fijo
--                               (pg_catalog, public y pg_temp al final: nunca
--                               gana; SEC-032) y nombres cualificados. Devuelve
--                               solo un booleano: ni qué clínicas ni cuántas.
--                               EXECUTE solo para dentalix_app.
--
-- Requisitos del rol que migra: owner de la tabla y CREATEROLE (no hace falta
-- superusuario ni BYPASSRLS), como DX-043 y DX-113. Es un rol del CLÚSTER:
-- create-app-role.sql y db:check-force vigilan sus miembros (DX-134).
-- Compatible hacia atrás: solo AÑADE (un rol, una política y una función); no
-- lee ni escribe filas.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Rol dueño. Si ya existe (otra base del mismo clúster) se reutiliza SOLO
--    con exactamente los atributos esperados y sin más miembros que el propio
--    migrador; si no, se aborta (un miembro con SET podría reemplazar la
--    función o leer las membresías de todas las clínicas).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname = 'dentalix_membership_lookup';
  IF NOT FOUND THEN
    CREATE ROLE dentalix_membership_lookup NOLOGIN NOINHERIT;
  ELSIF r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreaterole
        OR r.rolcreatedb OR r.rolreplication THEN
    RAISE EXCEPTION 'El rol dentalix_membership_lookup ya existe con atributos inesperados (LOGIN, SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB o REPLICATION). Revísalo a mano antes de migrar.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m
              WHERE m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'dentalix_membership_lookup')
                AND m.member <> (SELECT oid FROM pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'El rol dentalix_membership_lookup tiene miembros inesperados (pg_auth_members). Revísalo a mano antes de migrar.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m
              WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = 'dentalix_membership_lookup')) THEN
    RAISE EXCEPTION 'El rol dentalix_membership_lookup es miembro de otros roles. Revísalo a mano antes de migrar.';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO dentalix_membership_lookup;
GRANT SELECT ("userId", "tenantId", "deletedAt")
  ON "clinic_memberships" TO dentalix_membership_lookup;

-- Permisiva, solo de lectura y solo para este rol: para él queda
-- `tenant_isolation OR true`. Para dentalix_app (y cualquier otro rol) no
-- cambia nada.
CREATE POLICY "membership_lookup_definer" ON "clinic_memberships"
  AS PERMISSIVE FOR SELECT TO dentalix_membership_lookup USING (true);

-- ---------------------------------------------------------------------------
-- 2. La función. «Otra» clínica = cualquier "tenantId" distinto de
--    p_tenant_id; con p_tenant_id NULL cuenta cualquier membresía activa (lo
--    prudente). Una membresía borrada ("deletedAt") no cuenta: ya no da
--    acceso. Sin p_user_id, false.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx_user_has_other_active_memberships(p_user_id uuid, p_tenant_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.clinic_memberships m
     WHERE m."userId" = p_user_id
       AND m."deletedAt" IS NULL
       AND m."tenantId" IS DISTINCT FROM p_tenant_id
  )
$$;

-- Permisos ANTES del traspaso: después, un migrador que no sea superusuario
-- ya no es dueño y su REVOKE/GRANT no tendría efecto.
REVOKE ALL ON FUNCTION public.dx_user_has_other_active_memberships(uuid, uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app') THEN
    GRANT EXECUTE ON FUNCTION public.dx_user_has_other_active_memberships(uuid, uuid) TO dentalix_app;
  END IF;
END
$$;

-- Traspaso al rol: ALTER ... OWNER exige poder hacer SET ROLE al nuevo dueño
-- y que este tenga CREATE en el esquema. Ambas cosas solo durante el traspaso.
GRANT dentalix_membership_lookup TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;
GRANT CREATE ON SCHEMA public TO dentalix_membership_lookup;
ALTER FUNCTION public.dx_user_has_other_active_memberships(uuid, uuid) OWNER TO dentalix_membership_lookup;
REVOKE CREATE ON SCHEMA public FROM dentalix_membership_lookup;
REVOKE dentalix_membership_lookup FROM CURRENT_USER;
