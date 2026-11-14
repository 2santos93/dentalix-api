-- DX-021-bis: reseteo manual de la verificación en dos pasos de un miembro que
-- perdió el móvil y sus códigos y no tiene otro ADMIN que lo haga. Solo tras el
-- procedimiento de docs/runbooks/mfa-recovery.md.
--
--   psql "$DIRECT_URL" -v email='persona@clinica.example' \
--     -f docs/runbooks/mfa-support-reset.sql
--
-- Nunca toca a un superadmin (ver platform-mfa.md). Deja un evento
-- `MFA_RESET_BY_SUPPORT` en la auditoría de CADA clínica donde la cuenta es
-- miembro: esa clínica lo ve en su registro. El actor es la propia cuenta (la
-- tabla exige uno y soporte no es miembro); quién lo ejecutó queda en el ticket.
BEGIN;
SELECT set_config('dentalix.mfa_reset_email', :'email', true);

DO $$
DECLARE
  v_email text := lower(trim(current_setting('dentalix.mfa_reset_email')));
  v_user record;
  v_tenants integer;
BEGIN
  SELECT id, "isPlatformAdmin", "mfaEnabledAt" INTO v_user
    FROM users WHERE email = v_email AND "deletedAt" IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No existe una cuenta activa con ese correo.';
  END IF;
  IF v_user."isPlatformAdmin" THEN
    RAISE EXCEPTION 'Es un superadmin: usa docs/runbooks/platform-mfa.md.';
  END IF;
  IF v_user."mfaEnabledAt" IS NULL THEN
    RAISE EXCEPTION 'Esta cuenta no tiene la verificación activa.';
  END IF;

  INSERT INTO audit_events
    (id, "tenantId", "actorUserId", "actorRole", action, "resourceType",
     "resourceId", metadata, "occurredAt")
  SELECT gen_random_uuid(), m."tenantId", v_user.id, m.role, 'UPDATE', 'STAFF_MEMBER',
         v_user.id, '{"reason":"MFA_RESET_BY_SUPPORT"}'::jsonb, now()
    FROM clinic_memberships m
   WHERE m."userId" = v_user.id AND m."deletedAt" IS NULL;
  GET DIAGNOSTICS v_tenants = ROW_COUNT;
  IF v_tenants = 0 THEN
    RAISE EXCEPTION 'La cuenta no es miembro activo de ninguna clínica.';
  END IF;

  DELETE FROM user_mfa_recovery_codes WHERE "userId" = v_user.id;
  UPDATE user_trusted_devices SET "revokedAt" = now()
   WHERE "userId" = v_user.id AND "revokedAt" IS NULL;
  UPDATE users
     SET "mfaTotpSecretEnc" = NULL, "mfaTotpPendingSecretEnc" = NULL,
         "mfaEnabledAt" = NULL, "mfaLastUsedStep" = NULL,
         "tokenVersion" = "tokenVersion" + 1
   WHERE id = v_user.id;
  DELETE FROM login_throttles
   WHERE "keyHash" = encode(sha256(convert_to('dentalix:login-mfa:' || v_user.id, 'UTF8')), 'hex');
  RAISE NOTICE 'Verificación restablecida en % clínica(s).', v_tenants;
END;
$$;

COMMIT;
