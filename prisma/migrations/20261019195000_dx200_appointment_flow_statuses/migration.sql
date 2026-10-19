-- DX-200: flujo del paciente en la clínica. Estados nuevos de la cita (llegó,
-- en sillón, listo para cobrar) y el motivo de recordatorio omitido cuando el
-- paciente ya está en la clínica. ADD VALUE va solo en su fichero: el valor
-- nuevo no se puede usar en la misma transacción que lo crea. Aditivo: no se
-- renombra ni se quita ningún valor y el código anterior no los usa.
ALTER TYPE "AppointmentStatus" ADD VALUE IF NOT EXISTS 'ARRIVED';
ALTER TYPE "AppointmentStatus" ADD VALUE IF NOT EXISTS 'IN_CHAIR';
ALTER TYPE "AppointmentStatus" ADD VALUE IF NOT EXISTS 'READY_FOR_CHECKOUT';
ALTER TYPE "AppointmentReminderSkipReason" ADD VALUE IF NOT EXISTS 'IN_CLINIC';
