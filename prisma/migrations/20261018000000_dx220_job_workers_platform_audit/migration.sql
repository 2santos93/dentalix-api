-- DX-220: cola vigilable (OPS-029) y reencolado auditado de fallidos.
--
--   job_workers            una fila por proceso worker (APP_ROLE worker|all):
--                          su id (el mismo de jobs."lockedBy"), papel,
--                          versión y último latido. El worker la actualiza en
--                          cada vuelta del bucle; GET /platform/jobs/stats
--                          cuenta como vivo el que latió hace menos de 60 s.
--                          La purga diaria de la cola borra los que llevan
--                          más de 7 días sin latir.
--   platform_audit_events  acciones de un superadmin sobre la PLATAFORMA (no
--                          sobre una clínica: esas van a audit_events, que
--                          exige tenant). Hoy solo JOB_RETRIED
--                          (POST /platform/jobs/:id/retry), sin el payload
--                          del trabajo. Append-only como audit_events y
--                          platform_access_audit.
--
-- RLS: NINGUNA de las dos, a propósito. Son tablas de PLATAFORMA sin columna
-- de tenant (ni FK a tenants): no hay filas de una clínica que aislar. Quedan
-- en la lista PLATFORM_TABLES de test/rls-catalog.int-spec.ts, que comprueba
-- que siguen sin tenant. job_workers solo guarda ids técnicos, versión y
-- fechas; platform_audit_events, el actor, el id del trabajo y su nombre,
-- intentos y tipo de error (metadata acotada a 2 KB), nunca datos del
-- paciente.
--
-- Compatible hacia atrás: solo AÑADE (dos tablas nuevas vacías, sus índices,
-- CHECK, una FK a users declarada dentro del CREATE TABLE y los triggers
-- append-only). No lee ni escribe filas existentes ni toca FORCE de nada, así
-- que corre igual con un owner sin superusuario ni BYPASSRLS (DX-113).
--
-- Grants: ALTER DEFAULT PRIVILEGES cubre a dentalix_app (SELECT, INSERT,
-- UPDATE, DELETE). En job_workers los necesita todos (latido con upsert y
-- purga). En platform_audit_events se le quitan UPDATE, DELETE, TRUNCATE y
-- TRIGGER; la inmutabilidad no depende de eso: la ponen los triggers.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. job_workers
-- ---------------------------------------------------------------------------
CREATE TABLE "job_workers" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "version" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('utc', now()),
    "lastBeatAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('utc', now()),

    CONSTRAINT "job_workers_pkey" PRIMARY KEY ("id"),
    -- Mismo tope que jobs."lockedBy".
    CONSTRAINT "job_workers_id_check" CHECK (length("id") BETWEEN 1 AND 120),
    CONSTRAINT "job_workers_role_check" CHECK ("role" IN ('worker', 'all')),
    CONSTRAINT "job_workers_version_check"
      CHECK ("version" IS NULL OR "version" ~ '^[A-Za-z0-9._+-]{1,64}$')
);

-- Workers vivos (latido reciente), el listado de stats (más reciente
-- primero) y la purga de los que dejaron de latir.
CREATE INDEX "job_workers_lastBeatAt_idx" ON "job_workers"("lastBeatAt");

-- ---------------------------------------------------------------------------
-- 2. platform_audit_events
-- ---------------------------------------------------------------------------
CREATE TABLE "platform_audit_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actorUserId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" UUID,
    "requestId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('utc', now()),

    CONSTRAINT "platform_audit_events_pkey" PRIMARY KEY ("id"),
    -- RESTRICT: la evidencia no se borra en cascada; el producto retira
    -- usuarios en blando.
    CONSTRAINT "platform_audit_events_actorUserId_fkey"
      FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "platform_audit_events_action_check" CHECK ("action" IN ('JOB_RETRIED')),
    CONSTRAINT "platform_audit_events_resource_type_check" CHECK ("resourceType" IN ('JOB')),
    CONSTRAINT "platform_audit_events_metadata_check"
      CHECK (jsonb_typeof("metadata") = 'object' AND pg_column_size("metadata") <= 2048),
    CONSTRAINT "platform_audit_events_request_id_check"
      CHECK ("requestId" IS NULL OR char_length("requestId") <= 200),
    CONSTRAINT "platform_audit_events_ip_check"
      CHECK ("ip" IS NULL OR char_length("ip") <= 64),
    CONSTRAINT "platform_audit_events_user_agent_check"
      CHECK ("userAgent" IS NULL OR char_length("userAgent") <= 512)
);

-- Listado reciente (paginable por (occurredAt, id)), acciones de un
-- superadmin (lado hijo de la FK) e historial de un trabajo.
CREATE INDEX "platform_audit_events_occurredAt_id_idx"
  ON "platform_audit_events"("occurredAt" DESC, "id" DESC);
CREATE INDEX "platform_audit_events_actorUserId_occurredAt_idx"
  ON "platform_audit_events"("actorUserId", "occurredAt");
CREATE INDEX "platform_audit_events_resourceType_resourceId_idx"
  ON "platform_audit_events"("resourceType", "resourceId");

-- Append-only (mismo criterio que audit_events y platform_access_audit): ni
-- UPDATE ni DELETE ni TRUNCATE, salvo DELETE/TRUNCATE de un superusuario
-- (limpieza de las bases de test).
CREATE FUNCTION "dx_forbid_platform_audit_event_mutation"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es append-only: no se permite % (DX-220)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "platform_audit_events_append_only"
  BEFORE UPDATE OR DELETE ON "platform_audit_events"
  FOR EACH ROW EXECUTE FUNCTION "dx_forbid_platform_audit_event_mutation"();

CREATE TRIGGER "platform_audit_events_no_truncate"
  BEFORE TRUNCATE ON "platform_audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "dx_forbid_platform_audit_event_mutation"();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE, TRIGGER ON "platform_audit_events" FROM "dentalix_app";
  END IF;
END;
$$;
