-- DX-380 (OPS-046): una tarea programada `singleton` no encola un tick nuevo
-- mientras el trabajo del anterior siga en PENDING o RUNNING. El tick saltado
-- se cuenta en su fila para `GET /platform/jobs/stats`:
--   "skippedCount"   ticks saltados desde que existe la tarea (0 por defecto);
--   "lastSkippedAt"  el último tick saltado (NULL si nunca saltó).
--
-- Compatible hacia atrás: dos columnas nuevas con default (o NULL). Una
-- réplica anterior no las nombra: sigue disparando cada tick como antes y no
-- las toca (solo actualiza "lastRunAt", "nextRunAt" y "updatedAt").
--
-- Bloqueos: ADD COLUMN con un default constante es solo de catálogo (sin
-- reescribir la tabla), pero toma ACCESS EXCLUSIVE en `job_schedules` un
-- instante. lock_timeout 5 s: si un worker la retiene (la transacción de
-- `fireDueSchedules` es corta), falla limpia; se ejecuta `npx prisma migrate
-- resolve --rolled-back 20261104120000_dx380_job_schedule_skips` y se repite
-- `migrate deploy`.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "job_schedules"
  ADD COLUMN "skippedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastSkippedAt" TIMESTAMP(3);

ALTER TABLE "job_schedules"
  ADD CONSTRAINT "job_schedules_skipped_count_check" CHECK ("skippedCount" >= 0);
