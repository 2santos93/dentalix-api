import { inMemoryAvailability } from './__fixtures__/availability';
import { InMemoryProviderScheduleRepository } from './__fixtures__/in-memory-provider-schedule.repository';

/**
 * DX-520-bis: el aviso «fuera del horario del profesional» escribe el día con
 * palabras y las horas con el reloj de la sede (DX-354), nunca `dd/mm` ni 24 h
 * fijas. Jueves 5 de noviembre de 2026; el profesional trabaja 9:00–13:00.
 */
const SEDE = 'sede-a';
const PROVIDER = 'prof-1';

function availability(
  timeZone: string,
  format: { locale: string | null; hourCycle: string | null },
) {
  const repo = new InMemoryProviderScheduleRepository();
  repo.currentLocationId = SEDE;
  repo.weekly.set(PROVIDER, [
    { locationId: SEDE, weekday: 4, startMinute: 540, endMinute: 780 },
  ]);
  return inMemoryAvailability(repo, timeZone, format);
}

/** 15:00–15:30 del jueves en la zona de la sede: fuera del tramo. */
function slotAt(utcStart: string) {
  const start = new Date(utcStart);
  return {
    providerId: PROVIDER,
    locationId: SEDE,
    start,
    end: new Date(start.getTime() + 30 * 60_000),
  };
}

describe('ProviderAvailabilityService · aviso de fuera de horario (DX-520-bis)', () => {
  it('sede en 12 h: el día con palabras y las horas con el reloj de 12 h', async () => {
    const message = await availability('America/New_York', {
      locale: 'en-US',
      hourCycle: 'h12',
    }).offScheduleMessage(slotAt('2026-11-05T20:00:00Z'));
    expect(message).toBe(
      'Fuera del horario del profesional en Sede (jueves 5 de noviembre: 9:00 a. m.–1:00 p. m.).',
    );
  });

  it('sede en 24 h: el mismo día con las mismas palabras y las horas en 24 h', async () => {
    const message = await availability('Europe/Berlin', {
      locale: 'de-DE',
      hourCycle: 'h23',
    }).offScheduleMessage(slotAt('2026-11-05T14:00:00Z'));
    expect(message).toBe(
      'Fuera del horario del profesional en Sede (jueves 5 de noviembre: 09:00–13:00).',
    );
  });

  it('sede sin reloj: el aviso sale igual, sin horas, y no bloquea', async () => {
    const message = await availability('America/Caracas', {
      locale: null,
      hourCycle: null,
    }).offScheduleMessage(slotAt('2026-11-05T19:00:00Z'));
    expect(message).toBe('Fuera del horario del profesional en Sede.');
  });

  it('ningún aviso escribe una fecha con barras', async () => {
    for (const [zone, locale, hourCycle, utc] of [
      ['America/New_York', 'en-US', 'h12', '2026-11-05T20:00:00Z'],
      ['Europe/Berlin', 'de-DE', 'h23', '2026-11-05T14:00:00Z'],
      ['America/Caracas', 'es-VE', 'h12', '2026-11-05T19:00:00Z'],
    ] as const) {
      const message = await availability(zone, {
        locale,
        hourCycle,
      }).offScheduleMessage(slotAt(utc));
      expect(message).not.toMatch(/\d{1,2}\/\d{1,2}/);
      expect(message).toContain('jueves 5 de noviembre');
    }
  });
});
