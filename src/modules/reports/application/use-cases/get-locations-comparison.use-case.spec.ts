import { BadRequestException } from '@nestjs/common';
import type { AllowedLocations } from '../../../../shared/tenancy/location-access';
import type { CivilPeriod } from '../../domain/comparison-period';
import {
  EMPTY_AGGREGATES,
  type PeriodAggregates,
} from '../../domain/kpi-definitions';
import type {
  ComparisonLocation,
  LocationsComparisonRepository,
  PeriodAggregation,
} from '../../domain/ports/locations-comparison-repository.port';
import {
  GetLocationsComparisonUseCase,
  INVALID_PERIOD_MESSAGE,
  PERIOD_TOO_LONG_MESSAGE,
} from './get-locations-comparison.use-case';

const NORTE: ComparisonLocation = {
  id: 'l-norte',
  name: 'Sede Norte',
  isActive: true,
  timeZone: 'America/Bogota',
};
const PRINCIPAL: ComparisonLocation = {
  id: 'l-principal',
  name: 'Sede principal',
  isActive: true,
  timeZone: 'America/Bogota',
};

const agg = (over: Partial<PeriodAggregates>): PeriodAggregates => ({
  ...EMPTY_AGGREGATES,
  ...over,
});

class FakeRepo implements LocationsComparisonRepository {
  locations = [PRINCIPAL, NORTE];
  byPeriod = new Map<string, PeriodAggregation>();
  calls: { period: CivilPeriod; currency?: string }[] = [];
  lastAllowed: AllowedLocations | null = null;

  listLocations(allowed: AllowedLocations) {
    this.lastAllowed = allowed;
    return Promise.resolve(
      allowed === 'ALL'
        ? this.locations
        : this.locations.filter((l) => allowed.includes(l.id)),
    );
  }

  aggregate(
    period: CivilPeriod,
    locations: readonly ComparisonLocation[],
    currency?: string,
  ) {
    this.calls.push({ period, currency });
    const found = this.byPeriod.get(`${period.from}..${period.to}`);
    const ids = new Set(locations.map((l) => l.id));
    return Promise.resolve({
      byLocation: new Map(
        [...(found?.byLocation ?? new Map<string, PeriodAggregates>())].filter(
          ([id]) => ids.has(id),
        ),
      ),
      attendedPatients: found?.attendedPatients ?? 0,
    });
  }
}

describe('GetLocationsComparisonUseCase (DX-014)', () => {
  let repo: FakeRepo;
  let useCase: GetLocationsComparisonUseCase;

  beforeEach(() => {
    repo = new FakeRepo();
    useCase = new GetLocationsComparisonUseCase(repo);
    // Octubre (31 días) contra los 31 días anteriores (31/08–30/09).
    repo.byPeriod.set('2026-10-01..2026-10-31', {
      byLocation: new Map([
        [
          PRINCIPAL.id,
          agg({
            production: new Map([['COP', 12]]),
            collected: new Map([
              ['COP', 9],
              ['USD', 50],
            ]),
            completed: 45,
            noShow: 5,
            attendedPatients: 3,
            newPatients: 2,
            completedMinutes: 600,
            openMinutes: 1200,
          }),
        ],
        [
          NORTE.id,
          agg({
            production: new Map([['USD', 200]]),
            collected: new Map([['USD', 100]]),
            completed: 10,
            noShow: 0,
            attendedPatients: 2,
            newPatients: 1,
            completedMinutes: 300,
            openMinutes: null,
          }),
        ],
      ]),
      attendedPatients: 4,
    });
    repo.byPeriod.set('2026-08-31..2026-09-30', {
      byLocation: new Map([
        [
          PRINCIPAL.id,
          agg({
            production: new Map([['COP', 10]]),
            collected: new Map([['COP', 10]]),
            completed: 46,
            noShow: 4,
            attendedPatients: 2,
            newPatients: 2,
            completedMinutes: 480,
            openMinutes: 1200,
          }),
        ],
      ]),
      attendedPatients: 2,
    });
  });

  const run = (over: Partial<Parameters<typeof useCase.execute>[0]> = {}) =>
    useCase.execute({
      from: '2026-10-01',
      to: '2026-10-31',
      compare: 'previous',
      allowedLocationIds: 'ALL',
      ...over,
    });

  it('una fila por sede, en el orden de las sedes, y el período anterior', async () => {
    const report = await run();
    expect(report).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-31',
      compare: 'previous',
      previousFrom: '2026-08-31',
      previousTo: '2026-09-30',
      currency: null,
      hasActivity: true,
    });
    expect(report.locations.map((r) => r.name)).toEqual([
      'Sede principal',
      'Sede Norte',
    ]);
    expect(repo.calls.map((c) => c.period)).toEqual([
      { from: '2026-10-01', to: '2026-10-31' },
      { from: '2026-08-31', to: '2026-09-30' },
    ]);
    expect(report.kpis.map((k) => k.key)).toHaveLength(8);
  });

  it('10 → 12 de producción es +20 % y mejora; no-show 8 % → 10 % empeora', async () => {
    const [principal] = (await run()).locations;
    // Las monedas de la fila son las mismas en todos los importes: USD sale
    // con 0 de producción porque hubo cobros en USD.
    expect(principal.metrics.production).toEqual([
      {
        currency: 'COP',
        value: 12,
        previous: 10,
        changePercent: 20,
        trend: 'BETTER',
      },
      {
        currency: 'USD',
        value: 0,
        previous: 0,
        changePercent: null,
        trend: 'EQUAL',
      },
    ]);
    expect(principal.metrics.noShowRate).toEqual({
      value: 10,
      previous: 8,
      changePercent: 25,
      trend: 'WORSE',
    });
    expect(principal.metrics.completedAppointments).toEqual({
      value: 45,
      previous: 46,
      changePercent: -2.2,
      trend: 'WORSE',
    });
    expect(principal.metrics.occupancy).toEqual({
      value: 50,
      previous: 40,
      changePercent: 25,
      trend: 'BETTER',
    });
  });

  it('una moneda que solo aparece en un período sale en los dos (0 frente a lo que hubo)', async () => {
    const [principal] = (await run()).locations;
    expect(principal.metrics.collected).toEqual([
      {
        currency: 'COP',
        value: 9,
        previous: 10,
        changePercent: -10,
        trend: 'WORSE',
      },
      {
        currency: 'USD',
        value: 50,
        previous: 0,
        changePercent: null,
        trend: 'BETTER',
      },
    ]);
    // Sin producción en USD: % de cobro en USD no se calcula.
    expect(principal.metrics.collectionRate).toEqual([
      {
        currency: 'COP',
        value: 75,
        previous: 100,
        changePercent: -25,
        trend: 'WORSE',
      },
      {
        currency: 'USD',
        value: null,
        previous: null,
        changePercent: null,
        trend: null,
      },
    ]);
  });

  it('«Total clínica» da un importe por moneda, nunca sumados entre monedas', async () => {
    const { total } = await run();
    expect(total.name).toBe('Total clínica');
    expect(total.locationId).toBeNull();
    expect(total.metrics.production.map((m) => [m.currency, m.value])).toEqual([
      ['COP', 12],
      ['USD', 200],
    ]);
    expect(total.metrics.collected.map((m) => [m.currency, m.value])).toEqual([
      ['COP', 9],
      ['USD', 150],
    ]);
    // Ticket medio del total: cobrado ÷ 4 pacientes distintos (no 3 + 2).
    expect(
      total.metrics.averageTicket.map((m) => [m.currency, m.value]),
    ).toEqual([
      ['COP', 2.25],
      ['USD', 37.5],
    ]);
    expect(total.metrics.completedAppointments.value).toBe(55);
    expect(total.metrics.newPatients.value).toBe(3);
    // Ocupación del total: solo la principal tiene horario (600 / 1200).
    expect(total.metrics.occupancy.value).toBe(50);
  });

  it('una sede sin actividad sale con ceros y sin monedas', async () => {
    repo.locations = [PRINCIPAL, NORTE, { ...NORTE, id: 'l-sur', name: 'Sur' }];
    const report = await run();
    const sur = report.locations[2];
    expect(sur.hasActivity).toBe(false);
    expect(sur.metrics.production).toEqual([]);
    expect(sur.metrics.completedAppointments).toEqual({
      value: 0,
      previous: 0,
      changePercent: null,
      trend: 'EQUAL',
    });
  });

  it('«sin comparación» no consulta otro período y no da variaciones', async () => {
    const report = await run({ compare: 'none' });
    expect(repo.calls).toHaveLength(1);
    expect(report.previousFrom).toBeNull();
    expect(report.locations[0].metrics.production).toEqual([
      {
        currency: 'COP',
        value: 12,
        previous: null,
        changePercent: null,
        trend: null,
      },
      {
        currency: 'USD',
        value: 0,
        previous: null,
        changePercent: null,
        trend: null,
      },
    ]);
  });

  it('«mismo período del año anterior»', async () => {
    const report = await run({ compare: 'previous_year' });
    expect([report.previousFrom, report.previousTo]).toEqual([
      '2025-10-01',
      '2025-10-31',
    ]);
  });

  it('las sedes son las permitidas (DX-089): el total solo suma esas', async () => {
    const report = await run({ allowedLocationIds: [NORTE.id] });
    expect(repo.lastAllowed).toEqual([NORTE.id]);
    expect(report.locations.map((r) => r.locationId)).toEqual([NORTE.id]);
    expect(
      report.total.metrics.production.map((m) => [m.currency, m.value]),
    ).toEqual([['USD', 200]]);
  });

  it('sin actividad en el período: hasActivity false', async () => {
    const report = await run({ from: '2026-01-01', to: '2026-01-31' });
    expect(report.hasActivity).toBe(false);
    expect(report.total.hasActivity).toBe(false);
  });

  it('pasa la moneda pedida al repositorio', async () => {
    const report = await run({ currency: 'USD' });
    expect(report.currency).toBe('USD');
    expect(repo.calls.every((c) => c.currency === 'USD')).toBe(true);
  });

  it.each([
    ['2026-10-32', '2026-10-31'],
    ['2026-10-31', '2026-10-01'],
    ['10/01/2026', '2026-10-31'],
  ])('periodo inválido (%s..%s) → 400', async (from, to) => {
    await expect(run({ from, to })).rejects.toThrow(
      new BadRequestException(INVALID_PERIOD_MESSAGE),
    );
  });

  it('más de 366 días → 400', async () => {
    await expect(run({ from: '2025-01-01', to: '2026-01-02' })).rejects.toThrow(
      new BadRequestException(PERIOD_TOO_LONG_MESSAGE),
    );
    await expect(
      run({ from: '2025-01-01', to: '2026-01-01' }),
    ).resolves.toBeDefined();
  });
});
