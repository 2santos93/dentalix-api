-- DX-137: sesiones visibles, aviso de inicio de sesión nuevo y cierre por
-- inactividad configurable por clínica.
--
-- Cambios (todos ADITIVOS, compatibles hacia atrás: el código anterior no lee
-- ni escribe nada de esto):
--   refresh_sessions."deviceLabel"  navegador y sistema, ya resumidos («Chrome en
--                                   Windows»). NUNCA el user-agent completo.
--   refresh_sessions."ipPrefix"     IP truncada (/24 IPv4, /48 IPv6). NUNCA la IP.
--   refresh_sessions."lastSeenAt"   último refresh (NULL en las familias
--                                   anteriores: cuentan desde "createdAt").
--   refresh_sessions."tokenVersion" la `tokenVersion` del usuario con la que
--                                   se emitió el token vigente: si ya no es la
--                                   del usuario (cambio de contraseña, MFA…), la
--                                   familia está muerta y no se lista. NULL en
--                                   las anteriores hasta su próximo refresh.
--   tenants."sessionIdleMinutes"    cierre por inactividad de la clínica,
--                                   15..240 min, por defecto 60.
--   clinic_sessions                 a qué clínica pertenece cada familia de
--                                   refresh (una por login en el host de la
--                                   clínica). Tabla de CLÍNICA con RLS FORCE: la
--                                   vista de sesiones (propia y del ADMIN) se
--                                   lee bajo la RLS del tenant. Se borra con su
--                                   familia (CASCADE desde refresh_sessions, que
--                                   se purga cuando vence su último token).
--   session_alerts                  el enlace «No fui yo» del email: SHA-256 del
--                                   token (UNIQUE), caducidad (24 h) y uso (un
--                                   solo uso). Tabla de CLÍNICA con RLS FORCE: el
--                                   enlace solo vale en el host de la clínica
--                                   donde se entró. Solo ids: sin IP ni UA.
--   user_login_devices              huellas de dispositivo ya vistas por el
--                                   usuario (SHA-256 de usuario + navegador y SO +
--                                   prefijo de IP) con su última vez. Tabla GLOBAL
--                                   del usuario (como user_trusted_devices): un
--                                   dispositivo es de la persona, no de una
--                                   clínica. Se purga a los 90 días sin uso.
--
-- FK sobre tablas con RLS FORCE (DX-134): dentro de los CREATE TABLE (nacen
-- vacías). FK directa a tenants con RESTRICT (DX-148). Política NULLIF
-- (DX-251). La app nunca borra session_alerts (NO_APP_DELETE); clinic_sessions
-- solo desaparece por la cascada de su familia.
--
-- lock_timeout 5 s, como el resto de ALTER de `tenants` y `refresh_sessions`
-- (las lee cada petición o cada refresh). Si falla, se reintenta el deploy.
--
-- Vuelta atrás: desplegar la API anterior y
--   DROP TABLE public."session_alerts";
--   DROP TABLE public."clinic_sessions";
--   DROP TABLE public."user_login_devices";
--   ALTER TABLE public."tenants" DROP COLUMN "sessionIdleMinutes";
--   ALTER TABLE public."refresh_sessions" DROP COLUMN "deviceLabel",
--     DROP COLUMN "ipPrefix", DROP COLUMN "lastSeenAt", DROP COLUMN "tokenVersion";
-- (el valor 'new-login' del enum se queda: no estorba).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "refresh_sessions"
  ADD COLUMN "deviceLabel" TEXT,
  ADD COLUMN "ipPrefix" TEXT,
  ADD COLUMN "lastSeenAt" TIMESTAMP(3),
  ADD COLUMN "tokenVersion" INTEGER,
  ADD CONSTRAINT "refresh_sessions_device_label_check"
    CHECK ("deviceLabel" IS NULL OR char_length("deviceLabel") BETWEEN 1 AND 120),
  -- Solo prefijos: a.b.c.0/24 o x:x:x::/48. Una IP completa no cabe.
  ADD CONSTRAINT "refresh_sessions_ip_prefix_check"
    CHECK ("ipPrefix" IS NULL
           OR "ipPrefix" ~ '^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.0/24$'
           OR "ipPrefix" ~ '^[0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}::/48$');

ALTER TABLE "tenants"
  ADD COLUMN "sessionIdleMinutes" INTEGER NOT NULL DEFAULT 60,
  ADD CONSTRAINT "tenants_session_idle_minutes_check"
    CHECK ("sessionIdleMinutes" BETWEEN 15 AND 240);

-- ---------------------------------------------------------------------------
-- clinic_sessions
-- ---------------------------------------------------------------------------
CREATE TABLE "clinic_sessions" (
    "sessionId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC'::text, now()),

    CONSTRAINT "clinic_sessions_pkey" PRIMARY KEY ("sessionId"),
    CONSTRAINT "clinic_sessions_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "clinic_sessions_sessionId_fkey"
      FOREIGN KEY ("sessionId") REFERENCES "refresh_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "clinic_sessions_tenantId_idx" ON "clinic_sessions"("tenantId");

ALTER TABLE "clinic_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clinic_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "clinic_sessions"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
-- La fila no cambia nunca: la app solo la crea (y la cascada la borra).
REVOKE UPDATE, DELETE, TRUNCATE ON "clinic_sessions" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- session_alerts
-- ---------------------------------------------------------------------------
CREATE TABLE "session_alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    -- Familia que disparó el aviso (sin FK: el aviso sobrevive a la purga).
    "sessionId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC'::text, now()),

    CONSTRAINT "session_alerts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "session_alerts_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "session_alerts_expiry_check" CHECK ("expiresAt" > "createdAt"),
    CONSTRAINT "session_alerts_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "session_alerts_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "session_alerts_tokenHash_key" ON "session_alerts"("tokenHash");
CREATE INDEX "session_alerts_tenantId_userId_idx" ON "session_alerts"("tenantId", "userId");

ALTER TABLE "session_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_alerts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "session_alerts"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
-- La app crea el enlace y lo marca usado (una vez); nunca lo borra.
REVOKE DELETE, TRUNCATE ON "session_alerts" FROM dentalix_app;

-- Un solo uso: "usedAt" se pone una vez y nada más cambia.
CREATE FUNCTION public.dx_session_alert_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD."usedAt" IS NOT NULL
     OR NEW."usedAt" IS NULL
     OR (NEW."id", NEW."tenantId", NEW."userId", NEW."sessionId", NEW."tokenHash",
         NEW."expiresAt", NEW."createdAt")
        IS DISTINCT FROM
        (OLD."id", OLD."tenantId", OLD."userId", OLD."sessionId", OLD."tokenHash",
         OLD."expiresAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'session_alerts: solo se marca como usado, una vez'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER session_alerts_guard
  BEFORE UPDATE ON "session_alerts"
  FOR EACH ROW EXECUTE FUNCTION public.dx_session_alert_guard();

-- ---------------------------------------------------------------------------
-- user_login_devices
-- ---------------------------------------------------------------------------
CREATE TABLE "user_login_devices" (
    "userId" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC'::text, now()),
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC'::text, now()),

    CONSTRAINT "user_login_devices_pkey" PRIMARY KEY ("userId", "fingerprint"),
    CONSTRAINT "user_login_devices_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "user_login_devices_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "user_login_devices_lastSeenAt_idx" ON "user_login_devices"("lastSeenAt");
