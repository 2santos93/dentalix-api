-- DX-048 (SEC-028): bloqueo del login por FALLOS, compartido entre réplicas.
--
-- Antes lo hacían dos baldes del rate limiter en memoria de cada réplica
-- (`login` IP+email 5/15 min y `login-account` email 50/h) que contaban
-- también los logins correctos: una clínica tras NAT o un atacante con el
-- email de una doctora la dejaban fuera hasta 1 h. Ahora:
--
--   scope ACCOUNT  una fila por cuenta (hash del email normalizado). Solo
--                  cuenta fallos; un login correcto borra la fila. Tras N
--                  fallos, espera creciente (1, 2, 4, 8… min con tope) en
--                  "blockedUntil". Los fallos se olvidan pasado un rato sin
--                  fallar (LOGIN_LOCKOUT_RESET_MS).
--   scope IP       una fila por IP (hash). Solo cuenta fallos en una ventana
--                  fija; al llegar al límite, bloqueada hasta que acaba la
--                  ventana. Un éxito NO la reinicia (si no, un atacante la
--                  limpiaría entrando con su propia cuenta).
--
-- Tabla de PLATAFORMA, sin "tenantId" ni RLS, como revoked_tokens: el login
-- ocurre antes de conocer al usuario y la cuenta es global (el mismo usuario
-- entra en varias clínicas con la misma contraseña). No guarda emails ni IPs
-- en claro, solo su SHA-256 con un prefijo de dominio ("keyHash"), ni nada de
-- la clínica: leerla no revela de qué clínica es nadie.
--
-- Las horas son de la BD (timezone('utc', now())): todas las réplicas ven el
-- mismo reloj. La purga de filas viejas va en el trabajo horario de tokens
-- (auth.purge-expired-tokens, DX-085).
--
-- Compatible hacia atrás: solo AÑADE (un enum y una tabla). Grants: ALTER
-- DEFAULT PRIVILEGES ya cubre a dentalix_app (SELECT, INSERT, UPDATE, DELETE).

CREATE TYPE "LoginThrottleScope" AS ENUM ('ACCOUNT', 'IP');

CREATE TABLE "login_throttles" (
    "scope" "LoginThrottleScope" NOT NULL,
    "keyHash" TEXT NOT NULL,
    "failures" INTEGER NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "lastFailureAt" TIMESTAMP(3) NOT NULL,
    "blockedUntil" TIMESTAMP(3),

    CONSTRAINT "login_throttles_pkey" PRIMARY KEY ("scope", "keyHash"),
    -- Solo un SHA-256 en hex: nunca un email ni una IP en claro.
    CONSTRAINT "login_throttles_key_hash_check" CHECK ("keyHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "login_throttles_failures_check" CHECK ("failures" >= 1)
);

-- La purga horaria: filas sin fallos recientes ni espera vigente.
CREATE INDEX "login_throttles_lastFailureAt_idx" ON "login_throttles"("lastFailureAt");
