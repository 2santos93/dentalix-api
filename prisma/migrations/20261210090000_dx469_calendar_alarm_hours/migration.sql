-- DX-469: «Añadir a mi calendario». Antelación de la alarma del evento .ics
-- de una cita, por sede, junto a los ajustes de recordatorio:
--
--   location_reminder_settings."calendarAlarmHours"  INT NOT NULL DEFAULT 24
--                                                     horas antes (0 = sin
--                                                     alarma), 0..168
--
-- Aditiva: DEFAULT constante (sin reescritura desde PG 11); el CHECK sobre una
-- columna recién creada con su DEFAULT no necesita VALIDATE aparte.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "location_reminder_settings"
  ADD COLUMN "calendarAlarmHours" INTEGER NOT NULL DEFAULT 24,
  ADD CONSTRAINT "location_reminder_settings_calendar_alarm_check"
    CHECK ("calendarAlarmHours" BETWEEN 0 AND 168);
