-- DX-039: retención legal de la historia clínica (Res. 839/2017: 15 años desde
-- la última atención; plazo doble o permanente en casos especiales) y bloqueo
-- de su supresión.
--
-- Cambios (todos ADITIVOS, compatibles hacia atrás: el código anterior no lee
-- ni escribe las columnas nuevas y sigue funcionando igual):
--   patients.last_attention_at        fecha de la última atención clínica.
--       La mantiene la BD (triggers de abajo) al insertar una evolución o al
--       dejar una cita en COMPLETED, y NUNCA retrocede (GREATEST). Así ningún
--       camino de la app (ni un INSERT por SQL) puede olvidarse de moverla.
--   patients.retention_extended       NONE | DOUBLE | PERMANENT (solo ADMIN).
--   patients.partially_suppressed_at  cuándo se hizo la supresión parcial.
--   patient_retention_actions         rastro APPEND-ONLY de los cambios de
--       retención y supresiones parciales con su MOTIVO y su autor (el motivo
--       es texto libre, por eso no va en audit_events, cuya metadata solo
--       admite códigos).
--   Backfill de last_attention_at con las evoluciones y citas atendidas que ya
--   existen, e índice parcial para la consulta de historias que salen de
--   retención.

SET LOCAL lock_timeout = '5s';

-- row_security = off (transacción actual), mismo criterio que
-- 20261016170000_data_processing_consents: `patients`, `clinical_entries` y
-- `appointments` tienen RLS FORCE, y con un dueño no superusuario el backfill
-- de la sección 1 vería 0 filas EN SILENCIO (todas las HC quedarían sin
-- retención). Así, o ve todas las filas, o la migración falla ("query would be
-- affected by row-level security policy") y hay que correrla con un rol
-- superusuario o BYPASSRLS.
SET LOCAL row_security = off;

CREATE TYPE "RetentionExtension" AS ENUM ('NONE', 'DOUBLE', 'PERMANENT');
CREATE TYPE "PatientRetentionActionKind" AS ENUM ('EXTENSION_CHANGED', 'PARTIAL_SUPPRESSION');

-- Columnas nullable / con DEFAULT constante: en PG16 no reescriben la tabla.
ALTER TABLE "patients"
  ADD COLUMN "last_attention_at" TIMESTAMP(3),
  ADD COLUMN "retention_extended" "RetentionExtension" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "partially_suppressed_at" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- 1. Backfill: la mayor fecha entre las evoluciones (también las archivadas:
--    siguen siendo HC) y las citas atendidas (COMPLETED, no borradas), con
--    tope en el momento actual (ver la sección 2).
-- ---------------------------------------------------------------------------
UPDATE "patients" p
SET "last_attention_at" = LEAST(a.last_at, pg_catalog.timezone('UTC', pg_catalog.now()))
FROM (
  SELECT "tenantId", "patientId", MAX(at) AS last_at
  FROM (
    SELECT "tenantId", "patientId", "entryDate" AS at FROM "clinical_entries"
    UNION ALL
    SELECT "tenantId", "patientId", "start" AS at FROM "appointments"
    WHERE "status" = 'COMPLETED' AND "deletedAt" IS NULL
  ) attentions
  GROUP BY "tenantId", "patientId"
) a
WHERE p."tenantId" = a."tenantId" AND p."id" = a."patientId";

-- ---------------------------------------------------------------------------
-- 2. Mantenimiento: triggers AFTER que adelantan la fecha (nunca la atrasan).
--    SECURITY INVOKER: el UPDATE corre como el rol de la app y bajo su RLS,
--    así que solo puede tocar pacientes de su propio tenant (el de la fila).
--    search_path fijo con pg_temp al final y nombres calificados (SEC-032).
--    Tope en el momento actual: `entryDate` y `start` los fija el cliente, y
--    una evolución (inmutable) fechada en el futuro alargaría la retención
--    para siempre sin pasar por el ADMIN. Las columnas son timestamp sin zona
--    en UTC (Prisma), de ahí timezone('UTC', now()).
-- ---------------------------------------------------------------------------
CREATE FUNCTION "dx_bump_patient_last_attention"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  attended_at timestamp(3);
BEGIN
  IF TG_TABLE_NAME = 'clinical_entries' THEN
    attended_at := NEW."entryDate";
  ELSE
    IF NEW."status" <> 'COMPLETED' OR NEW."deletedAt" IS NOT NULL THEN
      RETURN NULL;
    END IF;
    attended_at := NEW."start";
  END IF;
  attended_at := LEAST(attended_at, pg_catalog.timezone('UTC', pg_catalog.now()));
  UPDATE public."patients"
  SET "last_attention_at" = attended_at
  WHERE "tenantId" = NEW."tenantId"
    AND "id" = NEW."patientId"
    AND ("last_attention_at" IS NULL OR "last_attention_at" < attended_at);
  RETURN NULL;
END;
$$;

CREATE TRIGGER "clinical_entries_bump_last_attention"
  AFTER INSERT ON "clinical_entries"
  FOR EACH ROW EXECUTE FUNCTION "dx_bump_patient_last_attention"();

CREATE TRIGGER "appointments_bump_last_attention"
  AFTER INSERT OR UPDATE OF "status", "start", "deletedAt" ON "appointments"
  FOR EACH ROW EXECUTE FUNCTION "dx_bump_patient_last_attention"();

-- ---------------------------------------------------------------------------
-- 3. Índice parcial para «historias que salen de retención» (pacientes vivos
--    de la clínica, por fecha de última atención).
-- ---------------------------------------------------------------------------
CREATE INDEX "patients_tenant_last_attention_live_idx"
  ON "patients"("tenantId", "last_attention_at")
  WHERE "deletedAt" IS NULL AND "last_attention_at" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. patient_retention_actions (append-only, RLS forzada).
-- ---------------------------------------------------------------------------
CREATE TABLE "patient_retention_actions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "kind" "PatientRetentionActionKind" NOT NULL,
    "previousExtension" "RetentionExtension",
    "newExtension" "RetentionExtension",
    "reason" TEXT NOT NULL,
    "actorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_retention_actions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "patient_retention_actions_reason_len"
      CHECK (char_length(btrim("reason")) BETWEEN 10 AND 500),
    -- Un cambio de retención dice de qué valor a qué valor; una supresión, no.
    CONSTRAINT "patient_retention_actions_extension_check" CHECK (
      ("kind" = 'EXTENSION_CHANGED' AND "previousExtension" IS NOT NULL AND "newExtension" IS NOT NULL)
      OR ("kind" = 'PARTIAL_SUPPRESSION' AND "previousExtension" IS NULL AND "newExtension" IS NULL)
    )
);

CREATE INDEX "patient_retention_actions_patient_created_idx"
  ON "patient_retention_actions"("tenantId", "patientId", "createdAt");

ALTER TABLE "patient_retention_actions" ADD CONSTRAINT "patient_retention_actions_tenantId_patientId_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "patient_retention_actions" ADD CONSTRAINT "patient_retention_actions_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Mismas reglas que la HC (DX-038): ni UPDATE ni DELETE ni TRUNCATE para la
-- app, y la fecha la pone el servidor de BD.
CREATE TRIGGER "patient_retention_actions_immutable"
  BEFORE UPDATE OR DELETE ON "patient_retention_actions"
  FOR EACH ROW EXECUTE FUNCTION "dx_forbid_clinical_record_mutation"();
CREATE TRIGGER "patient_retention_actions_no_truncate"
  BEFORE TRUNCATE ON "patient_retention_actions"
  FOR EACH STATEMENT EXECUTE FUNCTION "dx_forbid_clinical_record_mutation"();
CREATE TRIGGER "patient_retention_actions_server_timestamp"
  BEFORE INSERT ON "patient_retention_actions"
  FOR EACH ROW EXECUTE FUNCTION "dx_clinical_record_server_timestamp"();

ALTER TABLE "patient_retention_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "patient_retention_actions" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "patient_retention_actions"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
