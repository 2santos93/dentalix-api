import {
  addFacts,
  classifyRetention,
  EMPTY_RETENTION_COUNTS,
  isActiveAtEnd,
  isLost,
  isNewNoReturn,
  retentionBounds,
  retentionDefinitions,
  retentionRateOf,
  RETENTION_SEGMENTS,
  withRate,
  type RetentionFacts,
} from './retention';

const none: RetentionFacts = {
  activeAtStart: false,
  activeWindowAtEnd: false,
  seenBefore: false,
  seenInPeriod: false,
  upcoming: false,
  returnedWithinDays: false,
};
const facts = (over: Partial<RetentionFacts>): RetentionFacts => ({
  ...none,
  ...over,
});

describe('Retención (DX-260): reglas por paciente', () => {
  it('activo al inicio que sigue viniendo: conservado (activo al final, no perdido)', () => {
    const f = facts({
      activeAtStart: true,
      seenBefore: true,
      activeWindowAtEnd: true,
    });
    expect(classifyRetention(f)).toEqual(['active_start', 'active_end']);
  });

  it('activo al inicio sin visita en la ventana final ni cita futura: perdido', () => {
    const f = facts({ activeAtStart: true, seenBefore: true });
    expect(isLost(f)).toBe(true);
    expect(isActiveAtEnd(f)).toBe(false);
    expect(classifyRetention(f)).toEqual(['active_start', 'lost']);
  });

  it('con cita futura agendada NO es perdido aunque su última atendida sea anterior al corte, y sigue activo al final', () => {
    const f = facts({ activeAtStart: true, seenBefore: true, upcoming: true });
    expect(isLost(f)).toBe(false);
    expect(isActiveAtEnd(f)).toBe(true);
    expect(classifyRetention(f)).toEqual(['active_start', 'active_end']);
  });

  it('una cita futura no hace activo al final a quien no lo era al inicio', () => {
    expect(isActiveAtEnd(facts({ seenBefore: true, upcoming: true }))).toBe(
      false,
    );
  });

  it('nuevo (primera atendida de su historia en el período) que vuelve en 90 días', () => {
    const f = facts({
      seenInPeriod: true,
      activeWindowAtEnd: true,
      returnedWithinDays: true,
    });
    expect(classifyRetention(f)).toEqual(['new', 'active_end']);
  });

  it('nuevo sin otra atendida en 90 días ni cita futura: nuevo sin regreso', () => {
    const f = facts({ seenInPeriod: true, activeWindowAtEnd: true });
    expect(isNewNoReturn(f)).toBe(true);
    expect(classifyRetention(f)).toEqual([
      'new',
      'active_end',
      'new_no_return',
    ]);
  });

  it('nuevo sin segunda visita pero con cita futura: no es «sin regreso»', () => {
    expect(
      isNewNoReturn(
        facts({ seenInPeriod: true, activeWindowAtEnd: true, upcoming: true }),
      ),
    ).toBe(false);
  });

  it('quien ya había venido, pasó el umbral y vuelve en el período: recuperado, no nuevo', () => {
    const f = facts({
      seenBefore: true,
      seenInPeriod: true,
      activeWindowAtEnd: true,
    });
    expect(classifyRetention(f)).toEqual(['active_end', 'reactivated']);
  });

  it('sin hechos (inactivo desde antes del corte y sin visita): ninguna cifra', () => {
    expect(classifyRetention(facts({ seenBefore: true }))).toEqual([]);
  });

  it('la cuenta cuadra: activos al final = activos al inicio − perdidos + nuevos + recuperados', () => {
    const counts = { ...EMPTY_RETENTION_COUNTS };
    const cases: [Partial<RetentionFacts>, number][] = [
      [{ activeAtStart: true, seenBefore: true, activeWindowAtEnd: true }, 7],
      [{ activeAtStart: true, seenBefore: true }, 2],
      [{ activeAtStart: true, seenBefore: true, upcoming: true }, 1],
      [{ seenInPeriod: true, activeWindowAtEnd: true }, 1],
      [
        {
          seenInPeriod: true,
          activeWindowAtEnd: true,
          returnedWithinDays: true,
        },
        2,
      ],
      [{ seenBefore: true, seenInPeriod: true, activeWindowAtEnd: true }, 0],
    ];
    for (const [f, n] of cases) addFacts(counts, facts(f), n);
    expect(withRate(counts)).toEqual({
      activeAtStart: 10,
      newPatients: 3,
      lost: 2,
      activeAtEnd: 11,
      reactivated: 0,
      newNoReturn: 1,
      retentionRate: 80,
    });
    expect(counts.activeAtEnd).toBe(
      counts.activeAtStart -
        counts.lost +
        counts.newPatients +
        counts.reactivated,
    );
  });

  it('retención: 2 decimales; sin activos al inicio, null', () => {
    expect(
      retentionRateOf({ activeAtStart: 3, activeAtEnd: 2, newPatients: 0 }),
    ).toBe(66.67);
    expect(
      retentionRateOf({ activeAtStart: 0, activeAtEnd: 4, newPatients: 4 }),
    ).toBeNull();
  });
});

describe('Retención (DX-260): cortes del período', () => {
  it('18 meses en Caracas: el corte es la medianoche de la sede del mismo día, 18 meses antes', () => {
    const b = retentionBounds(
      { from: '2026-01-01', to: '2026-06-30' },
      18,
      'America/Caracas',
    );
    expect(b.periodStart.toISOString()).toBe('2026-01-01T04:00:00.000Z');
    expect(b.periodEnd.toISOString()).toBe('2026-07-01T04:00:00.000Z');
    expect(b.startCutoff.toISOString()).toBe('2024-07-01T04:00:00.000Z');
    expect(b.endCutoff.toISOString()).toBe('2025-01-01T04:00:00.000Z');
  });

  it('una cita el mismo día del corte (a las 08:00 de la sede) cae dentro de la ventana; la de las 23:00 del día anterior, fuera', () => {
    const b = retentionBounds(
      { from: '2026-01-01', to: '2026-06-30' },
      18,
      'America/Caracas',
    );
    const sameDay = new Date('2024-07-01T12:00:00Z');
    const dayBefore = new Date('2024-07-01T03:00:00Z');
    expect(sameDay >= b.startCutoff).toBe(true);
    expect(dayBefore >= b.startCutoff).toBe(false);
  });

  it('una cita el último día del período a las 23:00 de la sede sigue en el período', () => {
    const b = retentionBounds(
      { from: '2026-01-01', to: '2026-06-30' },
      12,
      'America/Caracas',
    );
    const lastNight = new Date('2026-07-01T03:00:00Z');
    expect(lastNight < b.periodEnd).toBe(true);
  });

  it('meses de calendario con el día recortado: 31/03 − 1 año sigue el 31/03; 29/02 se recorta al 28/02', () => {
    const b = retentionBounds(
      { from: '2028-02-29', to: '2028-03-31' },
      12,
      'UTC',
    );
    expect(b.startCutoff.toISOString()).toBe('2027-02-28T00:00:00.000Z');
    expect(b.endCutoff.toISOString()).toBe('2027-04-01T00:00:00.000Z');
  });
});

describe('Retención (DX-260): definiciones publicadas', () => {
  it('una por cifra, cada lista con su cifra y el umbral elegido en el texto', () => {
    const defs = retentionDefinitions(24);
    expect(defs.map((d) => d.segment).filter(Boolean)).toEqual(
      expect.arrayContaining([...RETENTION_SEGMENTS]),
    );
    expect(
      defs.find((d) => d.key === 'activeAtStart')!.howItIsCalculated,
    ).toContain('24 meses');
    expect(
      defs.find((d) => d.key === 'newNoReturn')!.howItIsCalculated,
    ).toContain('90 días');
    for (const d of defs) {
      expect(d.howItIsCalculated).toContain(
        'canceladas, no asistidas y borradas no',
      );
      expect(d.howItIsCalculated).toContain('historia suprimida');
    }
  });
});
