-- Borrado blando en los tramos de horario.
--
-- Hasta ahora guardar el horario de una sede hacía DELETE de los tramos viejos
-- y creaba los nuevos: el único borrado duro de datos de dominio que quedaba en
-- el backend. Se perdía el rastro de qué horario tenía la sede en cada momento.
ALTER TABLE "location_schedule_ranges" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Índice parcial: todas las lecturas piden los tramos VIVOS de un schedule
-- (`WHERE scheduleId = ? AND deletedAt IS NULL`). El índice existente
-- (tenantId, scheduleId, weekday) ya no basta cuando la tabla acumula historia.
CREATE INDEX "location_schedule_ranges_live_idx"
  ON "location_schedule_ranges"("scheduleId", "weekday")
  WHERE "deletedAt" IS NULL;

-- Cascade -> Restrict. Los padres (location_schedules, payment_plans) se borran
-- SIEMPRE en blando, así que un DELETE duro sobre ellos solo puede ser un error.
-- Con ON DELETE CASCADE ese error se llevaba los hijos por delante en silencio;
-- con RESTRICT la base de datos lo rechaza y el error sale a la luz.
ALTER TABLE "location_schedule_ranges"
  DROP CONSTRAINT "location_schedule_ranges_scheduleId_fkey";
ALTER TABLE "location_schedule_ranges"
  ADD CONSTRAINT "location_schedule_ranges_scheduleId_fkey"
  FOREIGN KEY ("scheduleId") REFERENCES "location_schedules"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "installments"
  DROP CONSTRAINT "installments_paymentPlanId_fkey";
ALTER TABLE "installments"
  ADD CONSTRAINT "installments_paymentPlanId_fkey"
  FOREIGN KEY ("paymentPlanId") REFERENCES "payment_plans"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
