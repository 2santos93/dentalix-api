/**
 * DX-495 (TST-062): reloj de las «fronteras de calendario».
 *
 * El cambio de mes del 31-10 al 01-11 tumbó la CI dos veces (DX-491, DX-466)
 * y la medianoche de la sede de los fixtures ya lo había hecho antes
 * (DX-449): ningún job corría los tests con la hora en una frontera. Con
 * `FAKE_NOW` (instante ISO con zona), `test/setup-calendar-clock.ts` sustituye
 * el `Date` de cada fichero de test por uno que ARRANCA en esa hora y avanza
 * con el reloj real. Es determinista y en proceso (sin libfaketime ni paquetes
 * del sistema). Solo cambia lo que lee `Date` dentro de jest: Postgres
 * (`now()`) y los timers siguen en la hora real.
 *
 * `E2E_FAKE_NOW` (DX-460, `test/support/fake-now.ts`) hace lo mismo para una
 * suite suelta y se instala después: si están las dos, gana la de DX-460.
 */
export const FAKE_NOW_ENV = 'FAKE_NOW';

/**
 * Un `Date` que suma `offsetMs` al «ahora» y deja igual todo lo demás. Comparte
 * el `prototype` del original: un `jest.spyOn(Date.prototype, …)` y las fechas
 * de `jest.useFakeTimers()` siguen viendo los mismos métodos.
 */
export function shiftedDate(
  RealDate: DateConstructor,
  offsetMs: number,
): DateConstructor {
  const now = () => RealDate.now() + offsetMs;
  function ShiftedDate(this: unknown, ...args: unknown[]): Date | string {
    // `Date()` sin `new` devuelve el texto de «ahora».
    if (!new.target) return new RealDate(now()).toString();
    return Reflect.construct(
      RealDate,
      args.length === 0 ? [now()] : args,
      new.target,
    ) as Date;
  }
  ShiftedDate.prototype = RealDate.prototype;
  Object.setPrototypeOf(ShiftedDate, RealDate);
  ShiftedDate.now = now;
  return ShiftedDate as unknown as DateConstructor;
}

const ISO_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * El instante de `FAKE_NOW` en ms, o null si no está fijado. Acepta un instante
 * ISO con zona o el nombre de una frontera (`fin-de-mes`, `medianoche-sede`,
 * `fin-de-anio`), que se resuelve con `calendarBoundary` desde `today`.
 */
export function parseFakeNow(
  value: string | undefined,
  today: Date = new Date(),
): number | null {
  if (!value) return null;
  if (isCalendarBoundary(value))
    return Date.parse(calendarBoundary(value, today));
  const ms = ISO_WITH_ZONE.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(ms))
    throw new Error(
      `${FAKE_NOW_ENV}="${value}" no es un instante ISO con zona (p. ej. 2026-12-31T23:59:30Z) ni una frontera (${CALENDAR_BOUNDARIES.join(', ')})`,
    );
  return ms;
}

export const CALENDAR_BOUNDARIES = [
  'fin-de-mes',
  'medianoche-sede',
  'fin-de-anio',
] as const;
export type CalendarBoundary = (typeof CALENDAR_BOUNDARIES)[number];

function isCalendarBoundary(value: string): value is CalendarBoundary {
  return (CALENDAR_BOUNDARIES as readonly string[]).includes(value);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** El último día (28–31) del mes `month` (0–11) de `year`. */
const lastDayOfMonth = (year: number, month: number) =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/**
 * La hora de cada frontera en el mes en curso (UTC), para que el reloj de la
 * app no se aleje del de Postgres:
 *  - fin-de-mes: el último día del mes (el 31 si lo tiene) a las 23:59:30 UTC;
 *  - medianoche-sede: el día 1 a las 05:01 UTC (un minuto después de la
 *    medianoche de una sede en UTC−5; la de los fixtures, UTC−4, ya pasó);
 *  - fin-de-anio: el 31 de diciembre del año en curso a las 23:59:30 UTC.
 */
export function calendarBoundary(
  kind: CalendarBoundary,
  today: Date = new Date(),
): string {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  if (kind === 'medianoche-sede')
    return `${year}-${pad(month + 1)}-01T05:01:00Z`;
  if (kind === 'fin-de-anio') return `${year}-12-31T23:59:30Z`;
  return `${year}-${pad(month + 1)}-${pad(lastDayOfMonth(year, month))}T23:59:30Z`;
}
