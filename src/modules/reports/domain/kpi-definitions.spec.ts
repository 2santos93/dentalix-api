import {
  changeOf,
  changePercent,
  combineAggregates,
  computeKpis,
  EMPTY_AGGREGATES,
  KPI_DEFINITIONS,
  KPI_KEYS,
  trendOf,
  type PeriodAggregates,
} from './kpi-definitions';

const aggregates = (
  over: Partial<PeriodAggregates> = {},
): PeriodAggregates => ({
  ...EMPTY_AGGREGATES,
  ...over,
});

describe('kpi-definitions (DX-014)', () => {
  it('define los ocho indicadores en el orden de la tabla, con su explicación', () => {
    expect(KPI_KEYS).toEqual([
      'production',
      'collected',
      'collectionRate',
      'completedAppointments',
      'noShowRate',
      'newPatients',
      'averageTicket',
      'occupancy',
    ]);
    for (const key of KPI_KEYS) {
      const def = KPI_DEFINITIONS[key];
      expect(def.key).toBe(key);
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.howItIsCalculated.length).toBeGreaterThan(20);
    }
  });

  it('solo el no-show mejora al bajar', () => {
    const lowerIsBetter = KPI_KEYS.filter(
      (k) => KPI_DEFINITIONS[k].direction === 'LOWER_IS_BETTER',
    );
    expect(lowerIsBetter).toEqual(['noShowRate']);
  });

  it('los importes son por moneda; los demás, un número', () => {
    expect(KPI_KEYS.filter((k) => KPI_DEFINITIONS[k].perCurrency)).toEqual([
      'production',
      'collected',
      'collectionRate',
      'averageTicket',
    ]);
  });

  describe('computeKpis con datos fijos', () => {
    const fixed = aggregates({
      production: new Map([
        ['COP', 1_000_000],
        ['USD', 400],
      ]),
      collected: new Map([
        ['COP', 750_000],
        ['USD', 100],
      ]),
      completed: 46,
      noShow: 4,
      attendedPatients: 25,
      newPatients: 3,
      completedMinutes: 2_400,
      openMinutes: 9_600,
    });

    it('producción y cobrado por moneda, sin sumar monedas distintas', () => {
      const kpis = computeKpis(fixed, ['COP', 'USD']);
      expect(kpis.production).toEqual([
        { currency: 'COP', value: 1_000_000 },
        { currency: 'USD', value: 400 },
      ]);
      expect(kpis.collected).toEqual([
        { currency: 'COP', value: 750_000 },
        { currency: 'USD', value: 100 },
      ]);
    });

    it('% de cobro = cobrado ÷ producción, en cada moneda', () => {
      expect(computeKpis(fixed, ['COP', 'USD']).collectionRate).toEqual([
        { currency: 'COP', value: 75 },
        { currency: 'USD', value: 25 },
      ]);
    });

    it('ticket medio = cobrado ÷ pacientes distintos atendidos', () => {
      expect(computeKpis(fixed, ['COP', 'USD']).averageTicket).toEqual([
        { currency: 'COP', value: 30_000 },
        { currency: 'USD', value: 4 },
      ]);
    });

    it('citas atendidas, no-show % sobre atendidas + no-show, nuevos y ocupación', () => {
      const kpis = computeKpis(fixed, ['COP', 'USD']);
      expect(kpis.completedAppointments).toBe(46);
      expect(kpis.noShowRate).toBe(8);
      expect(kpis.newPatients).toBe(3);
      expect(kpis.occupancy).toBe(25);
    });

    it('una moneda sin producción da % de cobro null (no 0 ni infinito)', () => {
      const kpis = computeKpis(
        aggregates({ collected: new Map([['EUR', 50]]) }),
        ['EUR'],
      );
      expect(kpis.production).toEqual([{ currency: 'EUR', value: 0 }]);
      expect(kpis.collectionRate).toEqual([{ currency: 'EUR', value: null }]);
    });

    it('sin citas: no-show y ticket null; sin horario: ocupación null', () => {
      const kpis = computeKpis(
        aggregates({ collected: new Map([['COP', 10]]), openMinutes: null }),
        ['COP'],
      );
      expect(kpis.noShowRate).toBeNull();
      expect(kpis.averageTicket).toEqual([{ currency: 'COP', value: null }]);
      expect(kpis.occupancy).toBeNull();
    });

    it('con horario pero cerrado todo el período, ocupación null', () => {
      expect(computeKpis(aggregates({ openMinutes: 0 }), []).occupancy).toBe(
        null,
      );
    });

    it('redondea los porcentajes a 2 decimales', () => {
      const kpis = computeKpis(
        aggregates({
          production: new Map([['COP', 3]]),
          collected: new Map([['COP', 1]]),
          completed: 2,
          noShow: 1,
        }),
        ['COP'],
      );
      expect(kpis.collectionRate[0].value).toBe(33.33);
      expect(kpis.noShowRate).toBe(33.33);
    });
  });

  describe('variación y tendencia', () => {
    it('los porcentajes varían en puntos; el resto, en % relativo', () => {
      expect(
        KPI_KEYS.filter((k) => KPI_DEFINITIONS[k].changeUnit === 'POINTS'),
      ).toEqual(['collectionRate', 'noShowRate', 'occupancy']);
      for (const key of KPI_KEYS) {
        expect(KPI_DEFINITIONS[key].changeUnit).toBe(
          KPI_DEFINITIONS[key].unit === 'PERCENT' ? 'POINTS' : 'PERCENT',
        );
      }
    });

    it('10 → 12 es +20 % y mejora', () => {
      expect(changeOf('production', 12, 10)).toBe(20);
      expect(changeOf('completedAppointments', 12, 10)).toBe(20);
      expect(trendOf('production', 12, 10)).toBe('BETTER');
    });

    it('no-show 8 % → 10 % es +2 p.p. (no +25 %) y empeora', () => {
      expect(changeOf('noShowRate', 10, 8)).toBe(2);
      expect(trendOf('noShowRate', 10, 8)).toBe('WORSE');
      expect(trendOf('noShowRate', 8, 10)).toBe('BETTER');
    });

    it('% de cobro y ocupación también en puntos, con 1 decimal', () => {
      expect(changeOf('collectionRate', 75, 100)).toBe(-25);
      expect(changeOf('occupancy', 33.33, 40)).toBe(-6.7);
      expect(changeOf('occupancy', 40, 40)).toBe(0);
    });

    it('en puntos, un anterior de 0 % sí tiene variación', () => {
      expect(changeOf('noShowRate', 5, 0)).toBe(5);
      expect(changeOf('noShowRate', null, 0)).toBeNull();
      expect(changeOf('occupancy', 10, null)).toBeNull();
    });

    it('bajar en un indicador que sube es peor; igual es igual', () => {
      expect(changePercent(9, 12)).toBe(-25);
      expect(trendOf('occupancy', 9, 12)).toBe('WORSE');
      expect(trendOf('collected', 5, 5)).toBe('EQUAL');
      expect(changePercent(5, 5)).toBe(0);
    });

    it('sin valor anterior (o 0) no hay variación %, pero sí tendencia si cambió', () => {
      expect(changePercent(12, 0)).toBeNull();
      expect(changeOf('production', 12, 0)).toBeNull();
      expect(changePercent(12, null)).toBeNull();
      expect(changePercent(null, 10)).toBeNull();
      expect(trendOf('production', 12, 0)).toBe('BETTER');
      expect(trendOf('production', 12, null)).toBeNull();
      expect(trendOf('noShowRate', null, 10)).toBeNull();
    });

    it('redondea la variación a 1 decimal', () => {
      expect(changePercent(2, 3)).toBe(-33.3);
    });
  });

  describe('combineAggregates (Total clínica)', () => {
    it('suma por moneda, citas y minutos; los pacientes distintos van aparte', () => {
      const a = aggregates({
        production: new Map([['COP', 100]]),
        collected: new Map([['COP', 50]]),
        completed: 10,
        noShow: 1,
        attendedPatients: 8,
        newPatients: 2,
        completedMinutes: 300,
        openMinutes: 1000,
      });
      const b = aggregates({
        production: new Map([['USD', 20]]),
        collected: new Map([
          ['COP', 25],
          ['USD', 5],
        ]),
        completed: 5,
        noShow: 4,
        attendedPatients: 5,
        newPatients: 1,
        completedMinutes: 100,
        openMinutes: 400,
      });
      const total = combineAggregates([a, b], 11);
      expect([...total.production]).toEqual([
        ['COP', 100],
        ['USD', 20],
      ]);
      expect([...total.collected]).toEqual([
        ['COP', 75],
        ['USD', 5],
      ]);
      expect(total).toMatchObject({
        completed: 15,
        noShow: 5,
        attendedPatients: 11,
        newPatients: 3,
        completedMinutes: 400,
        openMinutes: 1400,
      });
    });

    it('la ocupación del total solo cuenta las sedes con horario', () => {
      const scheduled = aggregates({ completedMinutes: 300, openMinutes: 600 });
      const unscheduled = aggregates({
        completedMinutes: 900,
        openMinutes: null,
      });
      const total = combineAggregates([scheduled, unscheduled], 0);
      expect(total.completedMinutes).toBe(300);
      expect(total.openMinutes).toBe(600);
      expect(computeKpis(total, []).occupancy).toBe(50);
    });

    it('sin ninguna sede con horario, la ocupación del total es null', () => {
      const total = combineAggregates(
        [aggregates({ completedMinutes: 30, openMinutes: null })],
        0,
      );
      expect(total.openMinutes).toBeNull();
    });
  });
});
