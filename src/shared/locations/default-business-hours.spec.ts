import {
  DEFAULT_BUSINESS_HOURS,
  DEFAULT_BUSINESS_HOURS_TIMEZONE,
} from './default-business-hours';
import { fitsBusinessHours } from '../../modules/location-schedule/application/business-hours';

// El horario por defecto se valida CONTRA el validador real, no contra una copia
// de la expectativa: así estos tests fallan si alguno de los dos se desalinea.
const hours = {
  timezone: DEFAULT_BUSINESS_HOURS_TIMEZONE,
  ranges: DEFAULT_BUSINESS_HOURS,
};

/** Instante UTC para una hora local de Bogotá (UTC-5 fijo) en una fecha dada. */
function bogota(dateIso: string, hour: number, minute = 0): Date {
  return new Date(`${dateIso}T${String(hour + 5).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);
}

describe('DEFAULT_BUSINESS_HOURS', () => {
  it('cubre lunes a sábado y deja el domingo cerrado', () => {
    const days = new Set(DEFAULT_BUSINESS_HOURS.map((r) => r.weekday));
    expect([...days].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(DEFAULT_BUSINESS_HOURS.filter((r) => r.weekday === 0)).toHaveLength(0);
  });

  it('todos los tramos son rangos válidos dentro del día', () => {
    for (const r of DEFAULT_BUSINESS_HOURS) {
      expect(r.startMinute).toBeGreaterThanOrEqual(0);
      expect(r.endMinute).toBeGreaterThan(r.startMinute);
      expect(r.endMinute).toBeLessThanOrEqual(1440);
    }
  });

  it('no tiene tramos solapados en el mismo día', () => {
    for (let weekday = 0; weekday <= 6; weekday++) {
      const day = DEFAULT_BUSINESS_HOURS.filter((r) => r.weekday === weekday).sort(
        (a, b) => a.startMinute - b.startMinute,
      );
      for (let i = 1; i < day.length; i++) {
        expect(day[i].startMinute).toBeGreaterThanOrEqual(day[i - 1].endMinute);
      }
    }
  });

  // 2026-08-03 lunes, 2026-08-01 sábado, 2026-08-02 domingo.
  it('acepta una cita un lunes por la mañana y por la tarde', () => {
    expect(fitsBusinessHours(bogota('2026-08-03', 10), bogota('2026-08-03', 10, 30), hours)).toBe(true);
    expect(fitsBusinessHours(bogota('2026-08-03', 16), bogota('2026-08-03', 16, 30), hours)).toBe(true);
  });

  it('rechaza el cierre de mediodía y la madrugada', () => {
    expect(fitsBusinessHours(bogota('2026-08-03', 14), bogota('2026-08-03', 14, 30), hours)).toBe(false);
    expect(fitsBusinessHours(bogota('2026-08-03', 3), bogota('2026-08-03', 3, 30), hours)).toBe(false);
  });

  it('el sábado cierra a las 13:00 y el domingo no se atiende', () => {
    expect(fitsBusinessHours(bogota('2026-08-01', 10), bogota('2026-08-01', 10, 30), hours)).toBe(true);
    expect(fitsBusinessHours(bogota('2026-08-01', 16), bogota('2026-08-01', 16, 30), hours)).toBe(false);
    expect(fitsBusinessHours(bogota('2026-08-02', 10), bogota('2026-08-02', 10, 30), hours)).toBe(false);
  });
});
