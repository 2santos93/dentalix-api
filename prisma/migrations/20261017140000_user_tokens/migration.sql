-- DX-010: recuperar la contraseña por email.
--
-- Compatible hacia atrás: solo AÑADE (un enum, un valor de enum y una tabla
-- con sus índices). No toca filas existentes.
--
-- `user_tokens` es una tabla GLOBAL de usuario, como `users` y
-- `revoked_tokens`: sin "tenantId" y, por tanto, sin RLS (rls-catalog la
-- trata como tabla no de clínica). El token pertenece a la persona, no a una
-- clínica; el aislamiento lo aplica el caso de uso: se pide y se usa en el
-- host de una clínica, y solo vale si el usuario tiene ahí una membresía
-- activa. Nunca guarda el token en claro (solo su SHA-256) ni el email ni la
-- IP de quien lo pidió.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en la tabla nueva.

CREATE TYPE "UserTokenPurpose" AS ENUM ('PASSWORD_RESET');

-- Nuevo valor para el registro de auditoría (DX-009). ADD VALUE es aditivo y
-- no se usa en esta misma transacción.
ALTER TYPE "AuditAction" ADD VALUE 'PASSWORD_RESET' BEFORE 'EXPORT';

CREATE TABLE "user_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "purpose" "UserTokenPurpose" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_tokens_pkey" PRIMARY KEY ("id"),
    -- SHA-256 en hex: nada que parezca un token en claro cabe aquí.
    CONSTRAINT "user_tokens_token_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "user_tokens_expires_check" CHECK ("expiresAt" > "createdAt"),
    -- Usado implica sin efecto (el uso también lo invalida).
    CONSTRAINT "user_tokens_used_check" CHECK ("usedAt" IS NULL OR "invalidatedAt" IS NOT NULL)
);

-- Buscar por el hash del enlace (único: 256 bits aleatorios).
CREATE UNIQUE INDEX "user_tokens_tokenHash_key" ON "user_tokens"("tokenHash");

-- Invalidar los anteriores del usuario al pedir uno nuevo; indexa además el
-- lado hijo de la FK a users.
CREATE INDEX "user_tokens_userId_purpose_createdAt_idx" ON "user_tokens"("userId", "purpose", "createdAt" DESC);

-- Limpieza de los caducados.
CREATE INDEX "user_tokens_expiresAt_idx" ON "user_tokens"("expiresAt");

-- Dato derivado del usuario: si el usuario se borra de verdad, sus tokens
-- no tienen sentido (los usuarios se retiran en blando; esto es la red).
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
