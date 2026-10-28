import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { BusinessCalendar } from '../time/business-days';
import {
  locationTimeZoneRequired,
  requireLocationTimeZone,
} from './location-time-zone';

/**
 * Calendario de días hábiles de una sede (DX-316) con su zona: lo que un
 * plazo en días hábiles necesita para `addBusinessDays`.
 */
export interface LocationBusinessCalendar extends BusinessCalendar {
  readonly locationId: string;
  readonly timeZone: string;
}

const logger = new Logger('LocationBusinessCalendar');

/**
 * Lee el calendario de la sede en la transacción del llamador (dentro de
 * `runWithTenant`; `tenantId` va explícito además de RLS), en dos consultas.
 *
 * - Sede sin zona válida, inexistente o de otro tenant → 409
 *   `LOCATION_TIMEZONE_REQUIRED`, como `resolveLocationTimeZones`.
 * - Sin fila de calendario se rompe el invariante R2 (la crean el trigger de
 *   alta y el backfill): se registra y se lanza
 *   `LOCATION_WORKING_CALENDAR_MISSING` (500). Nunca se suponen unos días.
 * - Solo los festivos vivos; `@db.Date` se pasa a 'YYYY-MM-DD' en UTC.
 */
export async function loadLocationBusinessCalendar(
  tx: Prisma.TransactionClient,
  tenantId: string,
  locationId: string,
): Promise<LocationBusinessCalendar> {
  const location = await tx.location.findFirst({
    where: { id: locationId, tenantId },
    select: {
      id: true,
      timeZone: true,
      workingCalendar: { select: { workingWeekdays: true } },
    },
  });
  if (!location) throw locationTimeZoneRequired(locationId);
  const timeZone = requireLocationTimeZone(location);
  if (!location.workingCalendar) {
    logger.error(
      `La sede ${locationId} del tenant ${tenantId} no tiene fila en location_working_calendars (R2)`,
    );
    throw new Error('LOCATION_WORKING_CALENDAR_MISSING');
  }
  const holidays = await tx.locationHoliday.findMany({
    where: { tenantId, locationId, deletedAt: null },
    select: { date: true, recurring: true },
  });
  return {
    locationId,
    timeZone,
    workingWeekdays: location.workingCalendar.workingWeekdays,
    holidays: holidays.map((h) => ({
      date: h.date.toISOString().slice(0, 10),
      recurring: h.recurring,
    })),
  };
}
