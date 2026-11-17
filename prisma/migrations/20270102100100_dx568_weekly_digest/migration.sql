-- DX-568: resumen semanal por email para el dueño.
--
-- Cambios (todos ADITIVOS, compatibles hacia atrás: el código anterior no lee
-- ni escribe nada de esto):
--   tenants."weeklyDigestEnabled"  BOOLEAN NOT NULL DEFAULT false
--   tenants."weeklyDigestWeekday"  INTEGER NOT NULL DEFAULT 1, 0..6 (0 = domingo)
--   tenants."weeklyDigestHour"     INTEGER NOT NULL DEFAULT 7, 0..23
--   weekly_digest_recipients       los ADMIN que lo reciben (PK clínica +
--                                  membresía). Configuración: la baja por
--                                  enlace borra la fila (queda en audit_events).
--   weekly_digest_runs             un envío por clínica y semana (UNIQUE): dos
--                                  workers no envían dos veces. Guarda el saldo
--                                  vencido del momento (base de la variación de
--                                  la semana siguiente). Sin DELETE de la app.
--   weekly_digest_deliveries       el email de un envío a un destinatario, con
--                                  el SHA-256 del token de baja (UNIQUE), su
--                                  caducidad, su uso y el email encolado. UNIQUE
--                                  (envío, membresía). Sin DELETE de la app.
--   email_outbox_weekly_digest_reference_key
--                                  un solo email por entrega (referenceId), como
--                                  el de los recordatorios (DX-272).
--
-- FK directa a tenants con RESTRICT (DX-148) y FK COMPUESTAS por clínica
-- (SEC-004) hacia la membresía y el envío. RLS ENABLE + FORCE con la política
-- NULLIF (DX-251). Ninguna tabla referencia pacientes (DX-266 no aplica). Las
-- FK van dentro de los CREATE TABLE (nacen vacías: la validación no lee filas).
-- El índice parcial de email_outbox se crea sobre una tabla que solo tiene
-- filas de otras plantillas: el predicado no casa con ninguna y no hay
-- duplicados que limpiar.
--
-- Vuelta atrás: desplegar la API anterior y
--   DROP INDEX public."email_outbox_weekly_digest_reference_key";
--   DROP TABLE public."weekly_digest_deliveries";
--   DROP TABLE public."weekly_digest_runs";
--   DROP TABLE public."weekly_digest_recipients";
--   DROP TYPE public."WeeklyDigestRunStatus";
--   ALTER TABLE public."tenants" DROP COLUMN "weeklyDigestEnabled",
--     DROP COLUMN "weeklyDigestWeekday", DROP COLUMN "weeklyDigestHour";
-- y se borra de `_prisma_migrations` la fila de esta migración (el valor
-- 'weekly-digest' del enum se queda: no estorba).
--
-- lock_timeout 5 s, como el resto de ALTER de `tenants` (toda petición la lee
-- al resolver la clínica). Si falla, se reintenta el deploy.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants"
  ADD COLUMN "weeklyDigestEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "weeklyDigestWeekday" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "weeklyDigestHour" INTEGER NOT NULL DEFAULT 7,
  ADD CONSTRAINT "tenants_weekly_digest_weekday_check"
    CHECK ("weeklyDigestWeekday" BETWEEN 0 AND 6),
  ADD CONSTRAINT "tenants_weekly_digest_hour_check"
    CHECK ("weeklyDigestHour" BETWEEN 0 AND 23);

CREATE TYPE "WeeklyDigestRunStatus" AS ENUM ('SENDING', 'SENT', 'SKIPPED');

-- ---------------------------------------------------------------------------
-- weekly_digest_recipients
-- ---------------------------------------------------------------------------
CREATE TABLE "weekly_digest_recipients" (
    "tenantId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC'::text, now()),

    CONSTRAINT "weekly_digest_recipients_pkey" PRIMARY KEY ("tenantId", "membershipId"),
    CONSTRAINT "weekly_digest_recipients_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "weekly_digest_recipients_membership_fkey"
      FOREIGN KEY ("tenantId", "membershipId")
      REFERENCES "clinic_memberships"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);

ALTER TABLE "weekly_digest_recipients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "weekly_digest_recipients" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "weekly_digest_recipients"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "weekly_digest_recipients" TO dentalix_app;
REVOKE TRUNCATE ON "weekly_digest_recipients" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- weekly_digest_runs
-- ---------------------------------------------------------------------------
CREATE TABLE "weekly_digest_runs" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "weekStart" DATE NOT NULL,
    "status" "WeeklyDigestRunStatus" NOT NULL DEFAULT 'SENDING',
    "receivablesSnapshot" JSONB,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC'::text, now()),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "weekly_digest_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "weekly_digest_runs_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- La semana empieza en lunes (ISODOW 1).
    CONSTRAINT "weekly_digest_runs_week_check" CHECK (EXTRACT(ISODOW FROM "weekStart") = 1),
    CONSTRAINT "weekly_digest_runs_counts_check" CHECK (
      "recipientCount" >= 0 AND "skippedCount" >= 0
    ),
    CONSTRAINT "weekly_digest_runs_snapshot_check" CHECK (
      "receivablesSnapshot" IS NULL OR jsonb_typeof("receivablesSnapshot") = 'object'
    ),
    CONSTRAINT "weekly_digest_runs_completed_check" CHECK (
      ("status" = 'SENDING') = ("completedAt" IS NULL)
    )
);

-- Destino de la FK compuesta de las entregas (SEC-004).
CREATE UNIQUE INDEX "weekly_digest_runs_tenant_id_key"
  ON "weekly_digest_runs"("tenantId", "id");
-- Un envío por clínica y semana: el INSERT … ON CONFLICT DO NOTHING del
-- trabajo lo usa (y sirve la búsqueda del envío de la semana anterior).
CREATE UNIQUE INDEX "weekly_digest_runs_tenant_week_key"
  ON "weekly_digest_runs"("tenantId", "weekStart");

ALTER TABLE "weekly_digest_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "weekly_digest_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "weekly_digest_runs"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON "weekly_digest_runs" TO dentalix_app;
REVOKE DELETE, TRUNCATE ON "weekly_digest_runs" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- weekly_digest_deliveries
-- ---------------------------------------------------------------------------
CREATE TABLE "weekly_digest_deliveries" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "unsubscribeTokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "emailOutboxId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC'::text, now()),

    CONSTRAINT "weekly_digest_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "weekly_digest_deliveries_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "weekly_digest_deliveries_run_fkey"
      FOREIGN KEY ("tenantId", "runId")
      REFERENCES "weekly_digest_runs"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "weekly_digest_deliveries_membership_fkey"
      FOREIGN KEY ("tenantId", "membershipId")
      REFERENCES "clinic_memberships"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "weekly_digest_deliveries_token_check"
      CHECK ("unsubscribeTokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "weekly_digest_deliveries_expiry_check"
      CHECK ("expiresAt" > "createdAt")
);

CREATE UNIQUE INDEX "weekly_digest_deliveries_token_key"
  ON "weekly_digest_deliveries"("unsubscribeTokenHash");
CREATE UNIQUE INDEX "weekly_digest_deliveries_run_membership_key"
  ON "weekly_digest_deliveries"("runId", "membershipId");
-- Lado hijo de la FK compuesta a la membresía.
CREATE INDEX "weekly_digest_deliveries_membership_idx"
  ON "weekly_digest_deliveries"("tenantId", "membershipId");

ALTER TABLE "weekly_digest_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "weekly_digest_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "weekly_digest_deliveries"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON "weekly_digest_deliveries" TO dentalix_app;
REVOKE DELETE, TRUNCATE ON "weekly_digest_deliveries" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- email_outbox: un email por entrega (DX-272)
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "email_outbox_weekly_digest_reference_key"
  ON "email_outbox" ("tenantId", "referenceId")
  WHERE "template" = 'weekly-digest' AND "referenceId" IS NOT NULL;
