-- DX-160: estado terminal del intento de entregar el recordatorio al outbox.
-- Sin reescribir filas existentes ni cambiar RLS/permisos.
ALTER TYPE "AppointmentReminderStatus" ADD VALUE 'FAILED';
ALTER TABLE "appointment_reminders" ADD COLUMN "failureReason" VARCHAR(200);
