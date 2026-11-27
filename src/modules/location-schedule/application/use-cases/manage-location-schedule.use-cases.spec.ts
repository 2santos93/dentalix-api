import { BadRequestException } from '@nestjs/common';
import {
  GetLocationScheduleUseCase,
  ReplaceLocationScheduleUseCase,
} from './manage-location-schedule.use-cases';
import {
  SCHEDULE_TIME_ZONE_MOVED,
  type LocationScheduleRepository,
  type ReplaceScheduleInput,
} from '../../domain/ports/location-schedule-repository.port';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { BusinessHours, ScheduleRange } from '../business-hours';

/**
 * DX-069: validación del horario semanal de la sede antes de guardarlo. La
 * zona ya no se guarda aquí (G1): es la de la sede, y el repositorio rechaza
 * con 400 una `timezone` obsoleta distinta (lo prueba
 * test/location-schedule.e2e-spec.ts y, con una zona inexistente,
 * test/business-hours.e2e-spec.ts).
 */
const AUDIT: AuditRequestContext = {
  tenantId: 't1',
  locationId: null,
  actor: { userId: 'u-admin', role: 'ADMIN' },
  requestId: 'req-1',
  ip: null,
  userAgent: null,
};
const ZONE = 'America/Caracas';
const range = (
  weekday: number,
  startHour: number,
  endHour: number,
): ScheduleRange => ({
  weekday,
  startMinute: startHour * 60,
  endMinute: endHour * 60,
});

function fakeRepo(stored: BusinessHours | null = null) {
  const replaced: {
    input: ReplaceScheduleInput;
    audit: AuditRequestContext;
  }[] = [];
  const repo: LocationScheduleRepository = {
    findByLocation: () => Promise.reject(new Error('no se usa')),
    findForCurrentLocation: () => Promise.resolve(stored),
    formatSourceOf: () => Promise.reject(new Error('no se usa')),
    holidaysOf: () => Promise.reject(new Error('no se usa')),
    replaceForCurrentLocation: (input, audit) => {
      replaced.push({ input, audit });
      return Promise.resolve({ timezone: ZONE, ranges: input.ranges });
    },
  };
  return { repo, replaced };
}

describe('GetLocationScheduleUseCase', () => {
  it('devuelve el horario de la sede en contexto', async () => {
    const hours: BusinessHours = { timezone: ZONE, ranges: [range(1, 9, 13)] };
    await expect(
      new GetLocationScheduleUseCase(fakeRepo(hours).repo).execute(),
    ).resolves.toBe(hours);
  });

  it('null = sede sin horario configurado (sin restricción)', async () => {
    await expect(
      new GetLocationScheduleUseCase(fakeRepo(null).repo).execute(),
    ).resolves.toBeNull();
  });
});

describe('ReplaceLocationScheduleUseCase', () => {
  const replace = (ranges: ScheduleRange[], legacyTimeZone?: string) => {
    const { repo, replaced } = fakeRepo();
    const run = new ReplaceLocationScheduleUseCase(repo).execute(
      { ranges, legacyTimeZone },
      AUDIT,
    );
    return { run, replaced };
  };

  /** Espera un 400 con `message` y que no se haya guardado nada. */
  async function expectRejected(
    ranges: ScheduleRange[],
    message: string,
  ): Promise<void> {
    const { run, replaced } = replace(ranges);
    await expect(run).rejects.toThrow(new BadRequestException(message));
    expect(replaced).toHaveLength(0);
  }

  it('guarda la semana lun–vie 9–13 y pasa la auditoría tal cual', async () => {
    const week = [1, 2, 3, 4, 5].map((d) => range(d, 9, 13));
    const { run, replaced } = replace(week);
    await expect(run).resolves.toEqual({ timezone: ZONE, ranges: week });
    expect(replaced).toEqual([
      { input: { ranges: week, legacyTimeZone: undefined }, audit: AUDIT },
    ]);
  });

  it('ranges: [] se guarda: la sede queda sin restricción', async () => {
    const { run, replaced } = replace([]);
    await expect(run).resolves.toEqual({ timezone: ZONE, ranges: [] });
    expect(replaced).toHaveLength(1);
  });

  it('dos tramos el mismo día (mañana y tarde) y el mismo tramo en días distintos son válidos', async () => {
    const { run } = replace([
      range(1, 15, 19),
      range(1, 9, 13),
      range(2, 9, 13),
    ]);
    await expect(run).resolves.toBeDefined();
  });

  it('tramos contiguos (uno empieza donde acaba el otro) no son solape', async () => {
    const { run } = replace([range(3, 9, 13), range(3, 13, 17)]);
    await expect(run).resolves.toBeDefined();
  });

  it('el día entero (0–1440) es válido', async () => {
    const { run } = replace([{ weekday: 6, startMinute: 0, endMinute: 1440 }]);
    await expect(run).resolves.toBeDefined();
  });

  it.each([
    ['solape parcial', [range(1, 9, 13), range(1, 12, 15)]],
    ['un tramo dentro de otro', [range(1, 9, 18), range(1, 10, 11)]],
    ['tramos iguales', [range(5, 9, 13), range(5, 9, 13)]],
    // Desordenados: se ordena por inicio antes de comparar.
    ['solape con los tramos desordenados', [range(0, 14, 16), range(0, 8, 15)]],
  ])('%s el mismo día → 400', async (_label, ranges) => {
    await expectRejected(
      ranges,
      'Hay tramos solapados en el mismo día; únelos en uno',
    );
  });

  it.each([
    [
      'startMinute = endMinute',
      { weekday: 1, startMinute: 540, endMinute: 540 },
    ],
    [
      'startMinute > endMinute',
      { weekday: 1, startMinute: 780, endMinute: 540 },
    ],
  ])('%s → 400', async (_label, bad) => {
    await expectRejected(
      [range(2, 9, 13), bad],
      'El fin de un tramo debe ser posterior a su inicio',
    );
  });

  it.each([
    ['negativo', -1],
    ['mayor que 6', 7],
    ['no entero', 1.5],
  ])('weekday %s → 400', async (_label, weekday) => {
    await expectRejected(
      [{ weekday, startMinute: 540, endMinute: 780 }],
      'weekday debe ser un entero de 0 (domingo) a 6 (sábado)',
    );
  });

  it.each([
    ['inicio negativo', { startMinute: -30, endMinute: 540 }],
    ['fin pasado la medianoche', { startMinute: 1380, endMinute: 1500 }],
    ['inicio no entero', { startMinute: 540.5, endMinute: 780 }],
    ['fin no entero', { startMinute: 540, endMinute: 779.9 }],
  ])('minutos fuera de rango (%s) → 400', async (_label, minutes) => {
    await expectRejected(
      [{ weekday: 1, ...minutes }],
      'startMinute/endMinute deben ser enteros entre 0 y 1440',
    );
  });

  it('la zona obsoleta (web antigua) llega al repositorio, que la compara con la de la sede', async () => {
    const { run, replaced } = replace([range(1, 9, 13)], ZONE);
    await run;
    expect(replaced[0].input.legacyTimeZone).toBe(ZONE);
  });

  it('una zona distinta o inexistente: el 400 del repositorio sale tal cual', async () => {
    const repo: LocationScheduleRepository = {
      ...fakeRepo().repo,
      replaceForCurrentLocation: () =>
        Promise.reject(new BadRequestException(SCHEDULE_TIME_ZONE_MOVED)),
    };
    await expect(
      new ReplaceLocationScheduleUseCase(repo).execute(
        { ranges: [range(1, 9, 13)], legacyTimeZone: 'Marte/Olympus_Mons' },
        AUDIT,
      ),
    ).rejects.toThrow(new BadRequestException(SCHEDULE_TIME_ZONE_MOVED));
  });
});
