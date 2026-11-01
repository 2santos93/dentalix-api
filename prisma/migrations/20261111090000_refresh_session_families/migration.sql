-- Familias de refresh tokens (carrera del refresh: recargar con /auth/refresh
-- en vuelo cerraba la sesión).
--
-- Compatible hacia atrás: solo AÑADE una tabla con sus índices. No toca filas
-- existentes. Los refresh tokens emitidos antes no llevan `sid`: siguen
-- rotando por la denylist `revoked_tokens` (un solo uso) y el par que reciben
-- ya nace en una familia.
--
-- Tabla GLOBAL, como `revoked_tokens` y `user_tokens`: sin "tenantId" y, por
-- tanto, sin RLS (la sesión de plataforma no tiene clínica; el aislamiento lo
-- da el propio token, que lleva su tenant y se comprueba contra el host).
-- Nunca guarda un token: solo sus `jti` (identificadores aleatorios).
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app en la tabla nueva.

CREATE TABLE "refresh_sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "currentJti" TEXT NOT NULL,
    "previousJti" TEXT,
    "rotatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_sessions_pkey" PRIMARY KEY ("id"),
    -- Hay token anterior si y solo si hubo una rotación.
    CONSTRAINT "refresh_sessions_rotation_check"
      CHECK (("previousJti" IS NULL) = ("rotatedAt" IS NULL)),
    CONSTRAINT "refresh_sessions_jti_check"
      CHECK ("previousJti" IS NULL OR "previousJti" <> "currentJti")
);

CREATE INDEX "refresh_sessions_expiresAt_idx" ON "refresh_sessions"("expiresAt");
CREATE INDEX "refresh_sessions_userId_idx" ON "refresh_sessions"("userId");
