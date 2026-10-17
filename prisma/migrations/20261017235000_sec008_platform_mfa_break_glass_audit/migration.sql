-- SEC-008: endurecer el acceso break-glass del superadmin a las clínicas.
--
-- Cambios:
--   users.mfaTotpSecretEnc         secreto TOTP del superadmin, CIFRADO
--                                  (AES-256-GCM con MFA_ENCRYPTION_KEY; el id
--                                  del usuario es el dato autenticado).
--   users.mfaTotpPendingSecretEnc  alta pedida y aún sin confirmar.
--   users.mfaEnabledAt             cuándo se confirmó el MFA.
--   users.mfaLastUsedStep          último paso TOTP aceptado: un código no
--                                  vale dos veces (anti-reutilización).
--   platform_access_audit          una fila por cada acceso break-glass de un
--                                  superadmin a una clínica sin membresía:
--                                  quién, a qué clínica, motivo, IP, user
--                                  agent, cuándo y hasta cuándo vale el token.
--   triggers                       append-only: ni UPDATE ni DELETE ni
--                                  TRUNCATE (salvo un superusuario: limpieza
--                                  de las bases de test).
--   RLS                            forzada por tenant: el ADMIN de la clínica
--                                  lee solo los accesos a SU clínica.
--
-- Compatible hacia atrás: solo AÑADE (cuatro columnas NULL sin default en
-- users, que no reescriben la tabla, y una tabla nueva vacía). Plan de
-- transición: los superadmins existentes nacen sin MFA; no pueden hacer
-- break-glass hasta enrolarlo desde su sesión de plataforma
-- (POST /platform/mfa/enrollment y /confirm).
--
-- FK: las dos van DENTRO del CREATE TABLE (la hija nace vacía) y apuntan a
-- tablas globales sin RLS (tenants, users). RESTRICT: la evidencia no se
-- borra en cascada; el producto retira clínicas y usuarios en blando.
--
-- Grants: ALTER DEFAULT PRIVILEGES cubre a dentalix_app en tablas nuevas; aquí
-- además se le quitan UPDATE, DELETE, TRUNCATE y TRIGGER (como audit_events,
-- DX-102). La inmutabilidad no depende de eso: la ponen los triggers.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. MFA de plataforma en users
-- ---------------------------------------------------------------------------
ALTER TABLE "users"
  ADD COLUMN "mfaTotpSecretEnc" TEXT,
  ADD COLUMN "mfaTotpPendingSecretEnc" TEXT,
  ADD COLUMN "mfaEnabledAt" TIMESTAMP(3),
  ADD COLUMN "mfaLastUsedStep" INTEGER;

-- MFA activo <=> hay secreto confirmado y fecha de alta.
ALTER TABLE "users" ADD CONSTRAINT "users_mfa_enabled_check"
  CHECK (("mfaTotpSecretEnc" IS NULL) = ("mfaEnabledAt" IS NULL));

-- ---------------------------------------------------------------------------
-- 2. platform_access_audit
-- ---------------------------------------------------------------------------
CREATE TABLE "platform_access_audit" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_access_audit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_access_audit_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "platform_access_audit_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Mismos topes que la API (400 antes); esto es la red.
    CONSTRAINT "platform_access_audit_reason_check"
      CHECK (char_length(btrim("reason")) BETWEEN 10 AND 500),
    CONSTRAINT "platform_access_audit_user_agent_check"
      CHECK ("userAgent" IS NULL OR char_length("userAgent") <= 512),
    CONSTRAINT "platform_access_audit_ip_check"
      CHECK ("ip" IS NULL OR char_length("ip") <= 64),
    -- El token break-glass dura como mucho 60 min.
    CONSTRAINT "platform_access_audit_expires_check"
      CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '60 minutes')
);

-- «Accesos de soporte» de la clínica: más reciente primero, paginado por
-- cursor (createdAt, id).
CREATE INDEX "platform_access_audit_tenantId_createdAt_id_idx"
  ON "platform_access_audit"("tenantId", "createdAt" DESC, "id" DESC);
-- Accesos de un superadmin (investigación de una cuenta comprometida).
CREATE INDEX "platform_access_audit_userId_createdAt_idx"
  ON "platform_access_audit"("userId", "createdAt");

-- ---------------------------------------------------------------------------
-- 3. Append-only (mismo criterio que audit_events, DX-009)
-- ---------------------------------------------------------------------------
CREATE FUNCTION "dx_forbid_platform_access_audit_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es append-only: no se permite % (SEC-008)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "platform_access_audit_append_only"
  BEFORE UPDATE OR DELETE ON "platform_access_audit"
  FOR EACH ROW EXECUTE FUNCTION "dx_forbid_platform_access_audit_mutation"();

CREATE TRIGGER "platform_access_audit_no_truncate"
  BEFORE TRUNCATE ON "platform_access_audit"
  FOR EACH STATEMENT EXECUTE FUNCTION "dx_forbid_platform_access_audit_mutation"();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE, TRIGGER ON "platform_access_audit" FROM "dentalix_app";
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. RLS forzada por tenant (mismo predicado que el resto, DX-068)
-- ---------------------------------------------------------------------------
ALTER TABLE "platform_access_audit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_access_audit" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "platform_access_audit"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
