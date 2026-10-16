-- DX-085: cola de trabajos en segundo plano sobre Postgres (sin Redis ni
-- pg-boss). Tabla propia reclamada con FOR UPDATE SKIP LOCKED, para poder
-- encolar DENTRO de la transacción de negocio de Prisma (outbox: el trabajo
-- solo existe si el negocio hace commit) y con el mismo rol de la app.
--
--   jobs           cola: un trabajo por fila (nombre del handler, payload
--                  con ids, estado, intentos, próxima hora, clave de
--                  idempotencia, último error).
--   job_schedules  una fila por tarea programada (cron) con su próximo tick.
--                  El worker que la bloquea con SKIP LOCKED encola el trabajo
--                  del tick (con idempotencyKey = nombre + tick) y la mueve
--                  al siguiente: un solo ejecutor por tick con N workers.
--
-- Compatible hacia atrás: solo AÑADE (un enum, dos tablas, índices, CHECK y
-- una FK de la tabla nueva a tenants). No lee ni escribe filas de ninguna
-- tabla existente, así que no necesita quitar FORCE a nada (DX-113) y corre
-- igual con un owner sin superusuario ni BYPASSRLS.
--
-- RLS: NO, a propósito (exención documentada en rls-catalog.int-spec.ts). Es
-- una tabla de PLATAFORMA: un worker reclama trabajos de todas las clínicas en
-- la misma sentencia. "tenantId" solo dice bajo qué clínica corre el handler,
-- que fija `app.current_tenant` (runWithTenant) antes de tocar datos de
-- clínica. El payload lleva SOLO ids (nunca datos del paciente; acotado a 4 KB)
-- y "lastError" solo el tipo y el código del error, nunca su mensaje.
--
-- Grants: ALTER DEFAULT PRIVILEGES ya cubre a dentalix_app (SELECT, INSERT,
-- UPDATE, DELETE); el DELETE es para purgar terminados.

CREATE TYPE "JobState" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

CREATE TABLE "jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "tenantId" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "state" "JobState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    -- PENDING: cuándo puede empezar (o reintentarse). RUNNING: cuándo vence el
    -- arriendo del worker que lo tiene (si muere, otro lo retoma entonces).
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('utc', now()),
    "idempotencyKey" TEXT,
    "lockedBy" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('utc', now()),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('utc', now()),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "jobs_name_check"
      CHECK (length("name") <= 80 AND "name" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$'),
    CONSTRAINT "jobs_payload_check"
      CHECK (jsonb_typeof("payload") = 'object' AND pg_column_size("payload") <= 4096),
    CONSTRAINT "jobs_max_attempts_check" CHECK ("maxAttempts" BETWEEN 1 AND 25),
    -- Un arriendo vencido en el último intento suma uno más antes de quedar
    -- FAILED sin ejecutarse: de ahí el + 1.
    CONSTRAINT "jobs_attempts_check" CHECK ("attempts" BETWEEN 0 AND "maxAttempts" + 1),
    CONSTRAINT "jobs_idempotency_key_check"
      CHECK ("idempotencyKey" IS NULL OR length("idempotencyKey") BETWEEN 1 AND 200),
    CONSTRAINT "jobs_last_error_check"
      CHECK ("lastError" IS NULL OR length("lastError") <= 200),
    CONSTRAINT "jobs_locked_by_check"
      CHECK ("lockedBy" IS NULL OR length("lockedBy") <= 120),
    -- Terminado <=> tiene hora de fin.
    CONSTRAINT "jobs_finished_check"
      CHECK (("state" IN ('COMPLETED', 'FAILED')) = ("finishedAt" IS NOT NULL))
);

-- Idempotencia POR CLÍNICA: un segundo enqueue con la misma clave en la misma
-- clínica (o en plataforma, tenantId NULL) no crea otra fila (INSERT ... ON
-- CONFLICT ... DO NOTHING). Dos clínicas con la misma clave no se pisan.
-- NULLS NOT DISTINCT (PG 15+): los trabajos de plataforma comparten ámbito.
-- Parcial: los trabajos sin clave no participan.
CREATE UNIQUE INDEX "jobs_tenantId_idempotencyKey_key" ON "jobs"("tenantId", "idempotencyKey")
  NULLS NOT DISTINCT WHERE "idempotencyKey" IS NOT NULL;

-- El reclamo de los workers: PENDING/RUNNING cuya hora llegó, en orden.
CREATE INDEX "jobs_state_runAt_idx" ON "jobs"("state", "runAt");

-- Cola de fallidos (endpoint de plataforma, los más recientes primero) y
-- purga de terminados por antigüedad.
CREATE INDEX "jobs_state_finishedAt_idx" ON "jobs"("state", "finishedAt");

-- Lado hijo de la FK a tenants: lo cubre el prefijo "tenantId" del índice
-- de idempotencia solo para filas con clave, así que hace falta el suyo.
CREATE INDEX "jobs_tenantId_idx" ON "jobs"("tenantId") WHERE "tenantId" IS NOT NULL;

-- CASCADE como email_outbox: los tenants nunca se borran en duro en el
-- producto; una limpieza administrativa no queda bloqueada por la cola.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "job_schedules" (
    "name" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('utc', now()),

    CONSTRAINT "job_schedules_pkey" PRIMARY KEY ("name"),
    CONSTRAINT "job_schedules_name_check"
      CHECK (length("name") <= 80 AND "name" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$'),
    CONSTRAINT "job_schedules_cron_check" CHECK (length("cron") BETWEEN 9 AND 100)
);
