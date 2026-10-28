import type { Prisma } from '@prisma/client';

export const LOCATION_CALENDAR_REPOSITORY = Symbol(
  'LOCATION_CALENDAR_REPOSITORY',
);

/** Un festivo vivo de la sede; `date` 'YYYY-MM-DD'. */
export interface HolidayView {
  id: string;
  date: string;
  name: string;
  recurring: boolean;
}

/** Festivos: recurrentes por (mes, día), luego puntuales por fecha. */
export interface LocationCalendarView {
  locationId: string;
  workingWeekdays: number[];
  holidays: HolidayView[];
}

/** Un festivo ya validado (fecha, nombre recortado, R6). */
export interface HolidayInput {
  date: string;
  name: string;
  recurring: boolean;
}

/**
 * Calendario de una sede viva del tenant en contexto (DX-316). Una sede que
 * no existe, es de otra clínica o está retirada es 404 `LOCATION_NOT_FOUND`;
 * una inactiva se puede editar. Toda escritura va dentro de
 * `withLockedCalendar`: el `FOR UPDATE` de la fila 1:1 serializa las
 * escrituras del calendario de la sede y hace cumplir R5 entre clases, que no
 * es una restricción de la BD.
 */
export interface LocationCalendarRepository {
  get(locationId: string): Promise<LocationCalendarView>;
  /** `days` ya normalizados; `before` = `after` si no cambia nada (no escribe). */
  setWorkingWeekdays(
    locationId: string,
    days: number[],
  ): Promise<{ before: number[]; after: number[]; view: LocationCalendarView }>;
  /** 409 `HOLIDAY_ALREADY_EXISTS` si choca con un vivo (R5, en las dos direcciones). */
  createHoliday(locationId: string, input: HolidayInput): Promise<HolidayView>;
  /**
   * 404 `HOLIDAY_NOT_FOUND` si no es un festivo vivo de la sede; 400 si el
   * resultado es un recurrente del 29 de febrero; 409 si choca con otro vivo
   * (el propio no cuenta).
   */
  updateHoliday(
    locationId: string,
    holidayId: string,
    patch: Partial<HolidayInput>,
  ): Promise<{ before: HolidayView; after: HolidayView }>;
  /** Retirada en blando (`deletedAt`); 404 si no es un festivo vivo de la sede. */
  retireHoliday(locationId: string, holidayId: string): Promise<HolidayView>;
  /**
   * Corre `fn` en una transacción del tenant con la fila de calendario de la
   * sede bloqueada (`FOR UPDATE`).
   */
  withLockedCalendar<T>(
    locationId: string,
    fn: (tx: Prisma.TransactionClient, tenantId: string) => Promise<T>,
  ): Promise<T>;
}
