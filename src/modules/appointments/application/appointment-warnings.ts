import type { AppointmentWarningCode } from '../domain/entities/appointment.entity';
import type { ScheduleWarning } from '../../provider-schedule/application/provider-availability.service';

/** Avisos de agendar o mover una cita, con su código en el mismo orden. */
export interface Warnings {
  warnings: string[];
  warningCodes: AppointmentWarningCode[];
}

export const NO_WARNINGS: Warnings = { warnings: [], warningCodes: [] };

/**
 * Junta el aviso del horario del profesional (DX-233), primero, y los de
 * los bloqueos que dejan agendar (DX-122).
 */
export function collectWarnings(
  blockWarnings: readonly string[],
  offSchedule: ScheduleWarning | null,
): Warnings {
  const out: Warnings = { warnings: [], warningCodes: [] };
  if (offSchedule) {
    out.warnings.push(offSchedule.message);
    out.warningCodes.push(offSchedule.code);
  }
  for (const message of blockWarnings) {
    out.warnings.push(message);
    out.warningCodes.push('SCHEDULE_BLOCK');
  }
  return out;
}
