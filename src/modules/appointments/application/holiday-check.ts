import { ConflictException } from '@nestjs/common';
import {
  LOCATION_HOLIDAY_CODE,
  appointmentOnHolidayMessage,
  holidayDuring,
} from '../../location-calendar/domain/holiday-rules';
import type { LocationScheduleRepository } from '../../location-schedule/domain/ports/location-schedule-repository.port';

/** El festivo que toca una cita: su día civil en la sede y su nombre. */
export interface HolidayHit {
  date: string;
  name: string;
}

/**
 * DX-263-bis: el festivo de la sede (DX-316) que toca [start, end) en la
 * zona de la sede, o null. `locationId` indefinido = la sede en contexto, la
 * misma en la que se escribe la cita.
 */
export async function findHolidayHit(
  schedule: Pick<LocationScheduleRepository, 'holidaysOf'>,
  slot: { locationId?: string; start: Date; end: Date },
): Promise<HolidayHit | null> {
  const { timeZone, holidays } = await schedule.holidaysOf(slot.locationId);
  if (timeZone === null) return null;
  const hit = holidayDuring(slot.start, slot.end, timeZone, holidays);
  return hit ? { date: hit.day, name: hit.name } : null;
}

/**
 * 409 `LOCATION_HOLIDAY` con el nombre del festivo: la sede está cerrada ese
 * día. `holiday` deja a la web nombrar el día sin leer el texto.
 */
export function holidayConflict(hit: HolidayHit): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: LOCATION_HOLIDAY_CODE,
    message: appointmentOnHolidayMessage(hit.name),
    holiday: { date: hit.date, name: hit.name },
  });
}

/**
 * DX-263-bis: agendar, mover o reactivar una cita en un festivo de su sede
 * es 409. No hay «agendar igualmente»: si la clínica abre ese día, el ADMIN
 * retira el festivo del calendario de la sede (Ajustes → Calendario).
 */
export async function assertNotOnHoliday(
  schedule: Pick<LocationScheduleRepository, 'holidaysOf'>,
  slot: { locationId?: string; start: Date; end: Date },
): Promise<void> {
  const hit = await findHolidayHit(schedule, slot);
  if (hit) throw holidayConflict(hit);
}
