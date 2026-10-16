-- DX-029 (SEC-006/007): registro sin enumeración de usuarios y con el email
-- verificado antes de crear nada.
--
-- Compatible hacia atrás: solo AÑADE (un valor de enum, una tabla y sus
-- índices). No toca filas existentes.
--
-- `pending_registrations` es una tabla GLOBAL (como `users` y `user_tokens`):
-- todavía no existe la clínica, así que no hay "tenantId" ni RLS. Guarda lo
-- justo para crear la clínica y su dueño cuando llegue el enlace del email:
-- nunca el token en claro (solo su SHA-256) ni la contraseña (solo su hash
-- argon2). Un registro nuevo para el mismo email reemplaza al anterior.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en la tabla nueva.

-- Aviso al titular cuando alguien intenta registrar una clínica con su email.
-- ADD VALUE es aditivo y no se usa en esta misma transacción.
ALTER TYPE "EmailTemplate" ADD VALUE 'registration-notice';

CREATE TABLE "pending_registrations" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "clinicName" TEXT NOT NULL,
    "subdomain" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_registrations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pending_registrations_token_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "pending_registrations_expires_check" CHECK ("expiresAt" > "createdAt")
);

-- Un único registro pendiente por email (el nuevo reemplaza al anterior).
CREATE UNIQUE INDEX "pending_registrations_email_key" ON "pending_registrations"("email");

-- Buscar por el hash del enlace.
CREATE UNIQUE INDEX "pending_registrations_tokenHash_key" ON "pending_registrations"("tokenHash");

-- Limpieza de los caducados.
CREATE INDEX "pending_registrations_expiresAt_idx" ON "pending_registrations"("expiresAt");

-- Límite diario de invitaciones por clínica (DX-029): contar las creadas en
-- las últimas 24 h.
CREATE INDEX "clinic_invitations_tenantId_createdAt_idx" ON "clinic_invitations"("tenantId", "createdAt" DESC);
