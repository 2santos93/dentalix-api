import {
  buildProductivity,
  PRODUCTIVITY_DEFINITIONS,
  UNNAMED_PROFESSIONAL,
} from './professional-productivity';
import { KPI_DEFINITIONS, noShowRateOf } from './kpi-definitions';

describe('noShowRateOf (DX-304, la fórmula de kpi-definitions)', () => {
  it('no asistió ÷ (atendidas + no asistió + tardías), 2 decimales', () => {
    expect(
      noShowRateOf({ completed: 7, noShow: 2, lateCancellations: 1 }),
    ).toBe(20);
    expect(
      noShowRateOf({ completed: 2, noShow: 1, lateCancellations: 0 }),
    ).toBe(33.33);
  });

  it('sin citas que cuenten no hay %', () => {
    expect(
      noShowRateOf({ completed: 0, noShow: 0, lateCancellations: 0 }),
    ).toBeNull();
  });
});

describe('buildProductivity (DX-304)', () => {
  const ana = {
    professionalId: '00000000-0000-4000-8000-00000000000a',
    fullName: 'Ana Rondón',
    production: [
      { currency: 'USD', count: 2, net: 100.1 },
      { currency: 'VES', count: 1, net: 3650.5 },
    ],
    collected: [{ currency: 'USD', amount: 40.05 }],
    completed: 3,
    noShow: 1,
    lateCancellations: 0,
  };
  const beto = {
    professionalId: '00000000-0000-4000-8000-00000000000b',
    fullName: 'Beto Álvarez',
    production: [{ currency: 'USD', count: 1, net: 0.2 }],
    collected: [],
    completed: 0,
    noShow: 1,
    lateCancellations: 1,
  };

  it('una fila por profesional, por nombre, con su no-show %', () => {
    const { rows } = buildProductivity([ana, beto]);
    expect(rows.map((r) => r.fullName)).toEqual(['Ana Rondón', 'Beto Álvarez']);
    expect(rows[0]).toMatchObject({
      completedAppointments: 3,
      noShows: 1,
      lateCancellations: 0,
      noShowRate: 25,
    });
    expect(rows[1].noShowRate).toBe(50);
  });

  it('los totales suman por moneda (nunca entre monedas), exactos en centavos', () => {
    const { totals } = buildProductivity([ana, beto]);
    expect(totals.production).toEqual([
      { currency: 'USD', count: 3, net: 100.3 },
      { currency: 'VES', count: 1, net: 3650.5 },
    ]);
    expect(totals.collected).toEqual([{ currency: 'USD', amount: 40.05 }]);
    expect(totals).toMatchObject({
      completedAppointments: 3,
      noShows: 2,
      lateCancellations: 1,
      noShowRate: 33.33,
    });
  });

  it('sin nombre legible, un texto fijo', () => {
    const { rows } = buildProductivity([{ ...beto, fullName: '  ' }]);
    expect(rows[0].fullName).toBe(UNNAMED_PROFESSIONAL);
  });

  it('sin filas, totales vacíos y sin %', () => {
    expect(buildProductivity([]).totals).toEqual({
      production: [],
      collected: [],
      completedAppointments: 0,
      noShows: 0,
      lateCancellations: 0,
      noShowRate: null,
    });
  });

  it('el no-show % reutiliza la definición de kpi-definitions', () => {
    expect(PRODUCTIVITY_DEFINITIONS.noShowRate.howItIsCalculated).toContain(
      KPI_DEFINITIONS.noShowRate.howItIsCalculated,
    );
    expect(PRODUCTIVITY_DEFINITIONS.noShowRate.direction).toBe(
      'LOWER_IS_BETTER',
    );
  });
});
