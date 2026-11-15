-- DX-146: política de avisos de saldo vencido de cada clínica («Por avisar
-- hoy» de la cartera).
--
--   tenants."balanceReminderDays"         INTEGER[] NOT NULL DEFAULT {7,30,60}
--       Días de la deuda vencida más antigua en que toca avisar (tramos), de
--       1 a 3 valores estrictamente crecientes entre 1 y 365.
--   tenants."balanceReminderMaxNotices"   INTEGER NOT NULL DEFAULT 3, 1..10
--       Máximo de avisos por deuda.
--   tenants."balanceReminderMinGapDays"   INTEGER NOT NULL DEFAULT 7, 1..90
--       Mínimo de días entre dos avisos al mismo paciente.
--
-- Expand puro: columnas NOT NULL con DEFAULT constante (PG 16: solo
-- catálogo), con sus CHECK en la misma sentencia (una fila por clínica,
-- milisegundos), como DX-448. Una réplica anterior no nombra las columnas.
-- La API repite los topes (400 en español); esto es la red.
--
-- Vuelta atrás (solo si hay que retirar DX-146):
--   1. Primero se despliega la versión anterior de la API, que no lee estas
--      columnas.
--   2. Después, en una transacción con el mismo lock_timeout:
--        ALTER TABLE "tenants"
--          DROP CONSTRAINT "tenants_balance_reminder_days_check",
--          DROP CONSTRAINT "tenants_balance_reminder_max_notices_check",
--          DROP CONSTRAINT "tenants_balance_reminder_min_gap_days_check",
--          DROP COLUMN "balanceReminderDays",
--          DROP COLUMN "balanceReminderMaxNotices",
--          DROP COLUMN "balanceReminderMinGapDays";
--      y se borra de `_prisma_migrations` la fila de esta migración.
--   Se pierde la política elegida por cada clínica. Las notas REMINDER_SENT
--   se quedan (append-only).
--
-- lock_timeout 5 s, como el resto de ALTER de `tenants` (toda petición la lee
-- al resolver la clínica). Si falla, se reintenta el deploy. Grants y RLS:
-- las columnas heredan los de su tabla.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants"
  ADD COLUMN "balanceReminderDays" INTEGER[] NOT NULL DEFAULT '{7,30,60}',
  ADD COLUMN "balanceReminderMaxNotices" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "balanceReminderMinGapDays" INTEGER NOT NULL DEFAULT 7,
  ADD CONSTRAINT "tenants_balance_reminder_days_check" CHECK (
    cardinality("balanceReminderDays") BETWEEN 1 AND 3
    AND array_position("balanceReminderDays", NULL) IS NULL
    AND 1 <= ALL ("balanceReminderDays")
    AND 365 >= ALL ("balanceReminderDays")
    AND (cardinality("balanceReminderDays") < 2
         OR "balanceReminderDays"[1] < "balanceReminderDays"[2])
    AND (cardinality("balanceReminderDays") < 3
         OR "balanceReminderDays"[2] < "balanceReminderDays"[3])
  ),
  ADD CONSTRAINT "tenants_balance_reminder_max_notices_check"
    CHECK ("balanceReminderMaxNotices" BETWEEN 1 AND 10),
  ADD CONSTRAINT "tenants_balance_reminder_min_gap_days_check"
    CHECK ("balanceReminderMinGapDays" BETWEEN 1 AND 90);
