-- DX-021: verificación en dos pasos (TOTP) para cualquier miembro, con
-- política por clínica para los ADMIN.
--
-- El secreto TOTP reutiliza las columnas del MFA del superadmin (SEC-008):
-- "users"."mfaTotpSecretEnc" / "mfaTotpPendingSecretEnc" / "mfaEnabledAt" /
-- "mfaLastUsedStep". El MFA es del USUARIO (tabla global): se pide en el
-- login de todas sus clínicas.
--
-- Aditiva: una columna con default y una tabla nueva. Grants: ALTER DEFAULT
-- PRIVILEGES ya cubre a dentalix_app (SELECT, INSERT, UPDATE, DELETE).

-- Política de la clínica: exigir el MFA a sus ADMIN. Apagada en todas las
-- clínicas existentes y nuevas (encenderla es decisión de cada clínica).
ALTER TABLE "tenants" ADD COLUMN "requireAdminMfa" BOOLEAN NOT NULL DEFAULT false;

-- Códigos de recuperación: solo su HMAC-SHA-256 (hex), nunca el código.
-- Global y sin RLS, como "users": el login los consulta antes de que haya
-- sesión, y no dicen nada de ninguna clínica.
CREATE TABLE "user_mfa_recovery_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_mfa_recovery_codes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_mfa_recovery_codes_hash_check" CHECK ("codeHash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "user_mfa_recovery_codes_userId_codeHash_key" ON "user_mfa_recovery_codes"("userId", "codeHash");

ALTER TABLE "user_mfa_recovery_codes" ADD CONSTRAINT "user_mfa_recovery_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
