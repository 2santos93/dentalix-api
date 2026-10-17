-- DX-144 (SEC-034, SEC-037): el registro público deja de ser un relé de
-- emails de Dentalix, y las filas de plataforma de email_outbox se purgan.
--
--   email_outbox_platform_allowed         ¿cabe otro email de PLATAFORMA
--                                         ("tenantId" NULL) al destinatario
--                                         p_to_hash? Como mucho uno cada
--                                         p_cooldown_seconds y p_daily_limit
--                                         en 24 h. Solo lee.
--   email_outbox_enqueue_platform_capped  lo mismo y, si cabe, encola el
--                                         email; si no, devuelve NULL. Un
--                                         candado de transacción por hash
--                                         serializa las réplicas: de N
--                                         peticiones a la vez al mismo
--                                         destinatario entra una.
--   email_outbox_purge_platform           borra por tandas los SENT/FAILED
--                                         de plataforma creados antes de
--                                         p_before (nunca de los últimos 7
--                                         días: el tope mira 24 h).
--
-- Las tres son SECURITY DEFINER del rol NOLOGIN dentalix_email_dispatcher
-- (DX-113), con search_path = pg_catalog, public, pg_temp, la tabla y el
-- tipo calificados con su esquema y las llamadas a pg_catalog calificadas
-- (SEC-032, SEC-035), y EXECUTE solo para dentalix_app. El tope se cuenta por el hash
-- del destinatario (HMAC), nunca por el email en claro.
--
-- Para la purga, el rol despachador recibe DELETE sobre email_outbox, acotado
-- por una política RESTRICTIVA a las filas de plataforma: aunque alguien
-- llegara a actuar como él, no podría borrar filas de una clínica.
-- dentalix_app no recibe ningún privilegio nuevo sobre la tabla.
--
-- Compatible hacia atrás: email_outbox_enqueue_platform (sin tope) se
-- conserva para las réplicas de la versión anterior durante el despliegue;
-- el código nuevo ya no la usa. Los índices existentes
-- ("tenantId", "toHash", "createdAt" DESC) y ("tenantId", "createdAt" DESC)
-- cubren las consultas nuevas ("tenantId" IS NULL es condición de índice).
--
-- Requisitos del rol que migra: los de 20261017175000 (owner de la tabla y
-- ADMIN OPTION sobre dentalix_email_dispatcher; sin superusuario ni
-- BYPASSRLS).
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. El rol sigue como lo dejó DX-113 (sin miembros inesperados): si no, no
--    se le traspasa nada más.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regrole('dentalix_email_dispatcher') IS NULL THEN
    RAISE EXCEPTION 'Falta el rol dentalix_email_dispatcher (migración 20261017175000_dx113_email_outbox_dispatcher_role).';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles
              WHERE rolname = 'dentalix_email_dispatcher'
                AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole
                     OR rolcreatedb OR rolreplication)) THEN
    RAISE EXCEPTION 'El rol dentalix_email_dispatcher tiene atributos inesperados (LOGIN, SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB o REPLICATION). Revísalo a mano antes de migrar.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m
              WHERE m.roleid = to_regrole('dentalix_email_dispatcher')
                AND m.member <> (SELECT oid FROM pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION 'El rol dentalix_email_dispatcher tiene miembros inesperados (pg_auth_members). Revísalo a mano antes de migrar.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. DELETE para el despachador, solo sobre filas de plataforma.
-- ---------------------------------------------------------------------------
GRANT DELETE ON "email_outbox" TO dentalix_email_dispatcher;

-- RESTRICTIVA: se suma con AND a las permisivas. Solo afecta a DELETE y solo
-- a este rol; para dentalix_app no cambia nada.
CREATE POLICY "email_outbox_dispatcher_delete_platform" ON "email_outbox"
  AS RESTRICTIVE FOR DELETE TO dentalix_email_dispatcher
  USING ("tenantId" IS NULL);

-- ---------------------------------------------------------------------------
-- 3. Funciones
-- ---------------------------------------------------------------------------
CREATE FUNCTION email_outbox_platform_allowed(
  p_to_hash text,
  p_cooldown_seconds integer,
  p_daily_limit integer
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_now timestamp(3) := pg_catalog.timezone('utc', pg_catalog.now());
  -- Acotados como la validación del arranque (env.validation.ts).
  v_cooldown integer := LEAST(GREATEST(COALESCE(p_cooldown_seconds, 0), 0), 86400);
  v_daily integer := LEAST(GREATEST(COALESCE(p_daily_limit, 1), 1), 1000);
  v_count integer;
  v_last timestamp(3);
BEGIN
  IF p_to_hash IS NULL OR p_to_hash = '' THEN
    RAISE EXCEPTION 'email_outbox_platform_allowed: falta el hash del destinatario';
  END IF;
  -- El enfriamiento nunca pasa de 24 h: basta mirar ese día.
  SELECT pg_catalog.count(*)::integer, pg_catalog.max(o."createdAt")
    INTO v_count, v_last
    FROM public."email_outbox" AS o
   WHERE o."tenantId" IS NULL
     AND o."toHash" = p_to_hash
     AND o."createdAt" > v_now - pg_catalog.make_interval(hours => 24);
  RETURN v_count < v_daily
     AND (v_last IS NULL
          OR v_last <= v_now - pg_catalog.make_interval(secs => v_cooldown));
END;
$$;

CREATE FUNCTION email_outbox_enqueue_platform_capped(
  p_template public."EmailTemplate",
  p_to_hash text,
  p_to_masked text,
  p_payload bytea,
  p_reference_id uuid,
  p_cooldown_seconds integer,
  p_daily_limit integer
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Un candado por destinatario hasta el final de la transacción: otra
  -- réplica con el mismo hash espera y, al seguir, ya ve esta fila.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('email_outbox_platform'),
    pg_catalog.hashtext(p_to_hash)
  );
  IF NOT public.email_outbox_platform_allowed(p_to_hash, p_cooldown_seconds, p_daily_limit) THEN
    RETURN NULL;
  END IF;
  -- "tenantId" NULL por construcción: esta vía no escribe en una clínica.
  INSERT INTO public."email_outbox"
    ("id", "tenantId", "template", "toHash", "toMasked", "referenceId",
     "payload", "status", "attempts", "nextAttemptAt", "createdAt", "updatedAt")
  VALUES
    (pg_catalog.gen_random_uuid(), NULL, p_template, p_to_hash, p_to_masked,
     p_reference_id, p_payload, 'PENDING', 0,
     pg_catalog.timezone('utc', pg_catalog.now()),
     pg_catalog.timezone('utc', pg_catalog.now()),
     pg_catalog.timezone('utc', pg_catalog.now()))
  RETURNING "id" INTO v_id;
  RETURN v_id;
END;
$$;

CREATE FUNCTION email_outbox_purge_platform(
  p_before timestamp(3),
  p_limit integer
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  -- Nunca lo de los últimos 7 días (MAIL_OUTBOX_RETENTION_DAYS ≥ 7).
  v_cutoff timestamp(3) := LEAST(
    p_before,
    pg_catalog.timezone('utc', pg_catalog.now()) - pg_catalog.make_interval(days => 7)
  );
  v_deleted integer;
BEGIN
  IF p_before IS NULL THEN
    RAISE EXCEPTION 'email_outbox_purge_platform: falta p_before';
  END IF;
  DELETE FROM public."email_outbox"
   WHERE "id" IN (
     SELECT o."id"
       FROM public."email_outbox" AS o
      WHERE o."tenantId" IS NULL
        AND o."status" IN ('SENT', 'FAILED')
        AND o."createdAt" < v_cutoff
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 5000)
   );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION email_outbox_platform_allowed(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION email_outbox_enqueue_platform_capped("EmailTemplate", text, text, bytea, uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION email_outbox_purge_platform(timestamp(3), integer) FROM PUBLIC;

-- GRANT explícito al rol de la app, como en 20261017120000_email_outbox.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app') THEN
    GRANT EXECUTE ON FUNCTION email_outbox_platform_allowed(text, integer, integer) TO dentalix_app;
    GRANT EXECUTE ON FUNCTION email_outbox_enqueue_platform_capped("EmailTemplate", text, text, bytea, uuid, integer, integer) TO dentalix_app;
    GRANT EXECUTE ON FUNCTION email_outbox_purge_platform(timestamp(3), integer) TO dentalix_app;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Traspaso al rol despachador (mismo procedimiento que DX-113: SET y
--    CREATE en el esquema solo para el traspaso).
-- ---------------------------------------------------------------------------
GRANT dentalix_email_dispatcher TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;
GRANT CREATE ON SCHEMA public TO dentalix_email_dispatcher;
ALTER FUNCTION email_outbox_platform_allowed(text, integer, integer) OWNER TO dentalix_email_dispatcher;
ALTER FUNCTION email_outbox_enqueue_platform_capped("EmailTemplate", text, text, bytea, uuid, integer, integer) OWNER TO dentalix_email_dispatcher;
ALTER FUNCTION email_outbox_purge_platform(timestamp(3), integer) OWNER TO dentalix_email_dispatcher;
REVOKE CREATE ON SCHEMA public FROM dentalix_email_dispatcher;
REVOKE dentalix_email_dispatcher FROM CURRENT_USER;
