-- DX-021-bis: los correos de seguridad de la verificación en dos pasos salen del
-- tope por destinatario de plataforma (DX-144). Con él, quien conoce la contraseña
-- de un superadmin sin MFA agotaba los 3 correos al día y el titular se quedaba
-- sin código de alta.
--
--   email_outbox_platform_allowed         deja de contar `mfa-notice` y
--                                         `mfa-enrollment-code`: no gastan el
--                                         cupo del registro público, y al revés.
--   email_outbox_enqueue_platform_security encola uno de esos correos con un
--                                         único tope: como mucho uno de esa
--                                         plantilla por p_min_interval_seconds.
--                                         El código del alta usa 600 s, así que
--                                         siempre hay uno vigente en el buzón y
--                                         ningún tercero puede agotarlo.
--
-- Mismas reglas que DX-144: SECURITY DEFINER del rol dentalix_email_dispatcher,
-- search_path fijo, EXECUTE solo para dentalix_app y traspaso con SET ROLE.
SET LOCAL lock_timeout = '5s';

GRANT dentalix_email_dispatcher TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;
GRANT CREATE ON SCHEMA public TO dentalix_email_dispatcher;
SET LOCAL ROLE dentalix_email_dispatcher;

CREATE OR REPLACE FUNCTION email_outbox_platform_allowed(
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
     AND o."template"::text NOT IN ('mfa-notice', 'mfa-enrollment-code')
     AND o."createdAt" > v_now - pg_catalog.make_interval(hours => 24);
  RETURN v_count < v_daily
     AND (v_last IS NULL
          OR v_last <= v_now - pg_catalog.make_interval(secs => v_cooldown));
END;
$$;

CREATE FUNCTION email_outbox_enqueue_platform_security(
  p_template public."EmailTemplate",
  p_to_hash text,
  p_to_masked text,
  p_payload bytea,
  p_reference_id uuid,
  p_min_interval_seconds integer
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_now timestamp(3) := pg_catalog.timezone('utc', pg_catalog.now());
  v_interval integer := LEAST(GREATEST(COALESCE(p_min_interval_seconds, 0), 0), 86400);
  v_id uuid;
BEGIN
  IF p_to_hash IS NULL OR p_to_hash = '' THEN
    RAISE EXCEPTION 'email_outbox_enqueue_platform_security: falta el hash del destinatario';
  END IF;
  IF p_template::text NOT IN ('mfa-notice', 'mfa-enrollment-code') THEN
    RAISE EXCEPTION 'email_outbox_enqueue_platform_security: plantilla no permitida';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('email_outbox_platform'),
    pg_catalog.hashtext(p_to_hash)
  );
  IF v_interval > 0 AND EXISTS (
    SELECT 1 FROM public."email_outbox" AS o
     WHERE o."tenantId" IS NULL
       AND o."toHash" = p_to_hash
       AND o."template" = p_template
       AND o."createdAt" > v_now - pg_catalog.make_interval(secs => v_interval)
  ) THEN
    RETURN NULL;
  END IF;
  INSERT INTO public."email_outbox"
    ("id", "tenantId", "template", "toHash", "toMasked", "referenceId",
     "payload", "status", "attempts", "nextAttemptAt", "createdAt", "updatedAt")
  VALUES
    (pg_catalog.gen_random_uuid(), NULL, p_template, p_to_hash, p_to_masked,
     p_reference_id, p_payload, 'PENDING', 0, v_now, v_now, v_now)
  RETURNING "id" INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION email_outbox_enqueue_platform_security("EmailTemplate", text, text, bytea, uuid, integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app') THEN
    GRANT EXECUTE ON FUNCTION email_outbox_enqueue_platform_security("EmailTemplate", text, text, bytea, uuid, integer) TO dentalix_app;
  END IF;
END;
$$;

RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM dentalix_email_dispatcher;
REVOKE dentalix_email_dispatcher FROM CURRENT_USER;
