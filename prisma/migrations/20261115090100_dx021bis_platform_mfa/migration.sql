-- DX-021-bis: segundo factor en el login del apex, política «obligatorio para
-- todos» y dispositivos de confianza.

-- Política: `requireAllMfa` implica `requireAdminMfa` (lo mantiene la API).
ALTER TABLE "tenants" ADD COLUMN "requireAllMfa" BOOLEAN NOT NULL DEFAULT false;

-- Dispositivo de confianza (30 días): solo la huella del token de la cookie.
-- `tokenVersion` lo ata a la versión de sesiones del usuario: cambiar la
-- contraseña o activar, desactivar o resetear el MFA lo deja sin valor.
-- Global, sin RLS (como `users` y `user_mfa_recovery_codes`).
CREATE TABLE "user_trusted_devices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenVersion" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "user_trusted_devices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_trusted_devices_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "user_trusted_devices_label_check" CHECK (char_length("label") BETWEEN 1 AND 120)
);

CREATE UNIQUE INDEX "user_trusted_devices_tokenHash_key" ON "user_trusted_devices"("tokenHash");
CREATE INDEX "user_trusted_devices_userId_expiresAt_idx" ON "user_trusted_devices"("userId", "expiresAt");

ALTER TABLE "user_trusted_devices" ADD CONSTRAINT "user_trusted_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Los eventos de plataforma ganan el login con segundo factor y la renovación
-- de los códigos de recuperación del superadmin.
ALTER TABLE "platform_audit_events" DROP CONSTRAINT "platform_audit_events_action_check";
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_action_check"
  CHECK ("action" IN ('JOB_RETRIED', 'MFA_ENROLLMENT_STARTED', 'MFA_ENABLED', 'PASSWORD_CHANGE', 'CLINICAL_RETENTION_MINIMUM_APPLIED', 'LOGIN', 'LOGIN_FAILED', 'MFA_RECOVERY_CODES_REGENERATED'));

-- Alta segura de los superadmin existentes (docs/runbooks/platform-mfa.md):
--  - se cierran sus sesiones de plataforma, abiertas solo con contraseña: la
--    siguiente entrada ya pasa por el segundo factor;
--  - se descarta el secreto PENDIENTE de quien no terminó el alta: pudo
--    pedirlo cualquiera con la contraseña, y el alta nueva exige además el
--    código enviado a su correo.
UPDATE "users"
   SET "tokenVersion" = "tokenVersion" + 1,
       "mfaTotpPendingSecretEnc" = NULL
 WHERE "isPlatformAdmin" = true;
