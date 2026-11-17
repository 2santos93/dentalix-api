import {
  buildForecast,
  buildScheduledView,
  civilDaysOf,
  convertGroups,
  FORECAST_FORMULA,
  memoizedDailyRates,
  monthBounds,
  rateDayFor,
  SCHEDULED_PRODUCTION_DEFINITION_KEYS,
  SCHEDULED_PRODUCTION_DEFINITION_LIST,
  scheduledProductionWarnings,
  toCatalogAmount,
  UNKNOWN_PROFESSIONAL_NAME,
  type ForecastAmountGroup,
  type ScheduledAmountGroup,
} from './scheduled-production';

const ANA = 'prof-ana';
const LUIS = 'prof-luis';
const MAIN = 'loc-main';

const amountGroup = (
  over: Partial<ScheduledAmountGroup>,
): ScheduledAmountGroup => ({
  day: '2026-11-17',
  professionalId: ANA,
  locationId: MAIN,
  currency: 'USD',
  amount: 0,
  items: 1,
  appointmentIds: [],
  ...over,
});

describe('producción agendada: funciones puras (DX-567)', () => {
  it('las definiciones salen todas, en orden, y la previsión trae la fórmula literal', () => {
    expect(SCHEDULED_PRODUCTION_DEFINITION_LIST.map((d) => d.key)).toEqual([
      ...SCHEDULED_PRODUCTION_DEFINITION_KEYS,
    ]);
    const forecast = SCHEDULED_PRODUCTION_DEFINITION_LIST.find(
      (d) => d.key === 'FORECAST',
    );
    expect(forecast?.howItIsCalculated[0]).toBe(`${FORECAST_FORMULA}.`);
    expect(FORECAST_FORMULA).toBe(
      'Previsión = Producido hasta hoy + Agendado pendiente',
    );
  });

  it('civilDaysOf: todos los días del período, ambos inclusive, cruzando meses', () => {
    expect(civilDaysOf('2026-11-29', '2026-12-02')).toEqual([
      '2026-11-29',
      '2026-11-30',
      '2026-12-01',
      '2026-12-02',
    ]);
    expect(civilDaysOf('2026-11-17', '2026-11-17')).toEqual(['2026-11-17']);
  });

  it('monthBounds: primer y último día, también en febrero bisiesto', () => {
    expect(monthBounds('2026-11-17')).toEqual({
      first: '2026-11-01',
      last: '2026-11-30',
    });
    expect(monthBounds('2028-02-10')).toEqual({
      first: '2028-02-01',
      last: '2028-02-29',
    });
    expect(monthBounds('2026-12-31').last).toBe('2026-12-31');
  });

  it('rateDayFor: el día de la cita; si es futuro, hoy', () => {
    expect(rateDayFor('2026-11-10', '2026-11-17')).toBe('2026-11-10');
    expect(rateDayFor('2026-11-17', '2026-11-17')).toBe('2026-11-17');
    expect(rateDayFor('2026-11-25', '2026-11-17')).toBe('2026-11-17');
  });

  it('toCatalogAmount: misma moneda tal cual; otra con tasas por 1 USD; sin tasa, null', () => {
    expect(toCatalogAmount(100, 'USD', 'USD', null)).toBe(100);
    // 3650 VES a 36,5 VES/USD = 100 USD.
    expect(toCatalogAmount(3650, 'VES', 'USD', { VES: 36.5 })).toBe(100);
    // 100 USD a VES (catálogo en VES).
    expect(toCatalogAmount(100, 'USD', 'VES', { VES: 36.5 })).toBe(3650);
    // EUR → VES pasando por USD: 10 EUR a 0,9 EUR/USD y 36 VES/USD = 400 VES.
    expect(
      toCatalogAmount(10, 'EUR', 'VES', { EUR: 0.9, VES: 36 }),
    ).toBeCloseTo(400, 8);
    expect(toCatalogAmount(100, 'VES', 'USD', null)).toBeNull();
    expect(toCatalogAmount(100, 'VES', 'USD', { EUR: 0.9 })).toBeNull();
    expect(toCatalogAmount(100, 'VES', 'USD', { VES: 0 })).toBeNull();
  });

  it('memoizedDailyRates: cada (día, moneda) se lee una sola vez', async () => {
    const fetch = jest.fn((day: string, currency: string) =>
      Promise.resolve(day === '2026-11-17' ? { [currency]: 36.5 } : null),
    );
    const ratesOf = memoizedDailyRates(fetch);
    await Promise.all([
      ratesOf('2026-11-17', 'VES'),
      ratesOf('2026-11-17', 'VES'),
      ratesOf('2026-11-16', 'VES'),
      ratesOf('2026-11-17', 'EUR'),
    ]);
    expect(await ratesOf('2026-11-17', 'VES')).toEqual({ VES: 36.5 });
    expect(await ratesOf('2026-11-16', 'VES')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('convertGroups: convierte con la tasa del día de cada grupo; sin catálogo, null sin leer tasas', async () => {
    const fetch = jest.fn((day: string) =>
      Promise.resolve(day === '2026-11-10' ? { VES: 40 } : null),
    );
    const ratesOf = memoizedDailyRates(fetch);
    const groups = [
      amountGroup({ amount: 40 }),
      amountGroup({ day: '2026-11-10', currency: 'VES', amount: 4000 }),
      amountGroup({ day: '2026-11-11', currency: 'VES', amount: 4000 }),
    ];
    const converted = await convertGroups(groups, 'USD', (g) => g.day, ratesOf);
    expect(converted.map((c) => c.amount)).toEqual([40, 100, null]);
    const none = await convertGroups(groups, null, (g) => g.day, ratesOf);
    expect(none.map((c) => c.amount)).toEqual([null, null, null]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('buildScheduledView: 40 + 60 = 100 al día y al profesional; los días sin citas en 0 y en orden', () => {
    const view = buildScheduledView({
      days: ['2026-11-16', '2026-11-17', '2026-11-18'],
      amounts: [
        { group: amountGroup({ amount: 40 }), amount: 40 },
        { group: amountGroup({ amount: 60 }), amount: 60 },
        {
          group: amountGroup({ professionalId: LUIS, amount: 25.555 }),
          amount: 25.555,
        },
      ],
      appointments: [
        {
          day: '2026-11-17',
          professionalId: ANA,
          locationId: MAIN,
          appointments: 2,
          withoutItems: 1,
        },
        {
          day: '2026-11-17',
          professionalId: LUIS,
          locationId: MAIN,
          appointments: 1,
          withoutItems: 0,
        },
      ],
      names: new Map([[ANA, 'Dra. Ana']]),
      withAmounts: true,
    });
    expect(view.totals).toEqual({
      scheduledAmount: 125.56,
      appointments: 3,
      appointmentsWithoutItems: 1,
    });
    expect(view.byDay).toEqual([
      {
        date: '2026-11-16',
        scheduledAmount: 0,
        appointments: 0,
        appointmentsWithoutItems: 0,
      },
      {
        date: '2026-11-17',
        scheduledAmount: 125.56,
        appointments: 3,
        appointmentsWithoutItems: 1,
      },
      {
        date: '2026-11-18',
        scheduledAmount: 0,
        appointments: 0,
        appointmentsWithoutItems: 0,
      },
    ]);
    expect(view.byProfessional).toEqual([
      {
        professionalId: ANA,
        name: 'Dra. Ana',
        scheduledAmount: 100,
        appointments: 2,
        appointmentsWithoutItems: 1,
      },
      {
        professionalId: LUIS,
        name: UNKNOWN_PROFESSIONAL_NAME,
        scheduledAmount: 25.56,
        appointments: 1,
        appointmentsWithoutItems: 0,
      },
    ]);
    expect(view.byDayAndProfessional).toEqual([
      {
        date: '2026-11-17',
        professionalId: ANA,
        scheduledAmount: 100,
        appointments: 2,
      },
      {
        date: '2026-11-17',
        professionalId: LUIS,
        scheduledAmount: 25.56,
        appointments: 1,
      },
    ]);
    expect(view.withoutRate).toEqual({ appointments: 0, items: 0 });
  });

  it('buildScheduledView: lo que no tiene tasa queda fuera y se cuenta una vez por cita', () => {
    const view = buildScheduledView({
      days: ['2026-11-17'],
      amounts: [
        { group: amountGroup({ amount: 50 }), amount: 50 },
        {
          group: amountGroup({
            currency: 'VES',
            amount: 900,
            items: 2,
            appointmentIds: ['c1', 'c2'],
          }),
          amount: null,
        },
        {
          group: amountGroup({
            currency: 'EUR',
            amount: 9,
            items: 1,
            appointmentIds: ['c1'],
          }),
          amount: null,
        },
      ],
      appointments: [
        {
          day: '2026-11-17',
          professionalId: ANA,
          locationId: MAIN,
          appointments: 3,
          withoutItems: 0,
        },
      ],
      names: new Map(),
      withAmounts: true,
    });
    expect(view.totals.scheduledAmount).toBe(50);
    expect(view.withoutRate).toEqual({ appointments: 2, items: 3 });
  });

  it('buildScheduledView sin moneda de catálogo: importes null, recuentos siguen, sin «sin tasa»', () => {
    const view = buildScheduledView({
      days: ['2026-11-17'],
      amounts: [
        {
          group: amountGroup({ amount: 50, appointmentIds: ['c1'] }),
          amount: null,
        },
      ],
      appointments: [
        {
          day: '2026-11-17',
          professionalId: ANA,
          locationId: MAIN,
          appointments: 1,
          withoutItems: 0,
        },
      ],
      names: new Map(),
      withAmounts: false,
    });
    expect(view.totals).toEqual({
      scheduledAmount: null,
      appointments: 1,
      appointmentsWithoutItems: 0,
    });
    expect(view.byDay[0].scheduledAmount).toBeNull();
    expect(view.withoutRate).toEqual({ appointments: 0, items: 0 });
  });

  it('buildForecast: previsión = producido + pendiente, de los dos ya redondeados', () => {
    const g = (amount: number, items = 1): ForecastAmountGroup => ({
      day: '2026-11-17',
      locationId: MAIN,
      currency: 'USD',
      amount,
      items,
    });
    const forecast = buildForecast({
      month: '2026-11',
      today: '2026-11-17',
      produced: [
        { group: g(100.004), amount: 100.004 },
        { group: g(10.001), amount: 10.001 },
        { group: g(999, 2), amount: null },
      ],
      pending: [{ group: g(50.005), amount: 50.005 }],
      withAmounts: true,
    });
    expect(forecast).toEqual({
      month: '2026-11',
      today: '2026-11-17',
      producedToDate: 110.01,
      scheduledPending: 50.01,
      forecast: 160.02,
      itemsWithoutRate: 2,
    });
    expect(
      buildForecast({
        month: '2026-11',
        today: '2026-11-17',
        produced: [{ group: g(1), amount: null }],
        pending: [],
        withAmounts: false,
      }),
    ).toMatchObject({
      producedToDate: null,
      scheduledPending: null,
      forecast: null,
      itemsWithoutRate: 0,
    });
  });

  it('los avisos: sin catálogo no avisa sin tasa; meses mezclados y realizados sin atribuir aparte', () => {
    expect(
      scheduledProductionWarnings({
        currency: null,
        withoutRate: 3,
        mixedMonths: false,
        unattributedDone: 0,
      }),
    ).toEqual(['NO_CATALOG_CURRENCY']);
    expect(
      scheduledProductionWarnings({
        currency: 'USD',
        withoutRate: 1,
        mixedMonths: true,
        unattributedDone: 2,
      }),
    ).toEqual(['WITHOUT_RATE', 'MIXED_MONTHS', 'UNATTRIBUTED_DONE']);
    expect(
      scheduledProductionWarnings({
        currency: 'USD',
        withoutRate: 0,
        mixedMonths: false,
        unattributedDone: 0,
      }),
    ).toEqual([]);
  });
});
