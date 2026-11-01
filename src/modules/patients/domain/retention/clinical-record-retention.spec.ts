import {
  floorCandidate,
  isUnderRetention,
  retentionUntil,
} from './clinical-record-retention';

const d = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe('retentionUntil (DX-039, DX-330)', () => {
  it('sin atenciones clínicas no hay retención', () => {
    const none = { until: null, basis: null };
    expect(retentionUntil(null, 'NONE', 15, null)).toEqual(none);
    expect(retentionUntil(null, 'DOUBLE', 15, null)).toEqual(none);
  });

  it.each([
    [15, '2035-03-10'],
    [20, '2040-03-10'],
    [30, '2050-03-10'],
  ])('NONE: %i años desde la última atención', (years, until) => {
    expect(retentionUntil(d('2020-03-10'), 'NONE', years, null)).toEqual({
      until: d(until),
      basis: 'TERM',
    });
  });

  it.each([
    [15, '2050-03-10'],
    [20, '2060-03-10'],
    [30, '2080-03-10'],
  ])('DOUBLE: el doble del plazo de %i años', (years, until) => {
    expect(retentionUntil(d('2020-03-10'), 'DOUBLE', years, null)).toEqual({
      until: d(until),
      basis: 'DOUBLE',
    });
  });

  it('PERMANENT: nunca se libera, aunque no haya atenciones o tenga suelo', () => {
    const permanent = { until: 'PERMANENT', basis: 'PERMANENT' };
    expect(retentionUntil(d('1990-01-01'), 'PERMANENT', 15, null)).toEqual(
      permanent,
    );
    expect(retentionUntil(null, 'PERMANENT', 20, null)).toEqual(permanent);
    expect(
      retentionUntil(d('1990-01-01'), 'PERMANENT', 15, d('2040-01-01')),
    ).toEqual(permanent);
  });

  it('29 de febrero: termina el 28 de febrero si el año final no es bisiesto', () => {
    expect(retentionUntil(d('2024-02-29'), 'NONE', 15, null).until).toEqual(
      d('2039-02-28'),
    );
    // 2024 + 30 = 2054, tampoco bisiesto.
    expect(retentionUntil(d('2024-02-29'), 'DOUBLE', 15, null).until).toEqual(
      d('2054-02-28'),
    );
  });

  it('29 de febrero con 20 años: 2044 es bisiesto y conserva el 29', () => {
    expect(retentionUntil(d('2024-02-29'), 'NONE', 20, null).until).toEqual(
      d('2044-02-29'),
    );
  });

  it('29 de febrero a última hora: cuenta el día civil y no salta a marzo', () => {
    expect(
      retentionUntil(new Date('2024-02-29T23:59:00.000Z'), 'NONE', 15, null)
        .until,
    ).toEqual(d('2039-02-28'));
    expect(retentionUntil(d('2024-03-01'), 'NONE', 15, null).until).toEqual(
      d('2039-03-01'),
    );
  });

  it('usa el día civil (UTC) de la atención, sin la hora', () => {
    expect(
      retentionUntil(new Date('2021-06-15T18:30:00.000Z'), 'NONE', 15, null)
        .until,
    ).toEqual(d('2036-06-15'));
  });

  it('el suelo gana si es mayor que la base', () => {
    expect(
      retentionUntil(d('2010-06-15'), 'NONE', 15, d('2035-06-15')),
    ).toEqual({ until: d('2035-06-15'), basis: 'PREVIOUS_TERM' });
    expect(
      retentionUntil(d('1990-06-15'), 'DOUBLE', 15, d('2040-06-15')),
    ).toEqual({ until: d('2040-06-15'), basis: 'PREVIOUS_TERM' });
  });

  it('el suelo pierde si es menor que la base', () => {
    expect(
      retentionUntil(d('2020-06-15'), 'NONE', 15, d('2030-06-15')),
    ).toEqual({ until: d('2035-06-15'), basis: 'TERM' });
    expect(
      retentionUntil(d('2020-06-15'), 'DOUBLE', 15, d('2030-06-15')),
    ).toEqual({ until: d('2050-06-15'), basis: 'DOUBLE' });
  });

  it('un suelo igual a la base no es el plazo anterior', () => {
    expect(
      retentionUntil(d('2020-06-15'), 'NONE', 15, d('2035-06-15')),
    ).toEqual({ until: d('2035-06-15'), basis: 'TERM' });
  });

  it('un suelo sin atención se respeta', () => {
    expect(retentionUntil(null, 'NONE', 15, d('2035-06-15'))).toEqual({
      until: d('2035-06-15'),
      basis: 'PREVIOUS_TERM',
    });
  });
});

describe('floorCandidate (DX-330)', () => {
  it('NONE cuenta una vez el plazo; DOUBLE y PERMANENT, dos', () => {
    const last = d('2010-06-15');
    expect(floorCandidate(last, 'NONE', 25)).toEqual(d('2035-06-15'));
    expect(floorCandidate(last, 'DOUBLE', 25)).toEqual(d('2060-06-15'));
    expect(floorCandidate(last, 'PERMANENT', 25)).toEqual(d('2060-06-15'));
  });

  it('usa el día civil UTC y la misma regla del 29 de febrero', () => {
    expect(
      floorCandidate(new Date('2024-02-29T23:59:00.000Z'), 'NONE', 15),
    ).toEqual(d('2039-02-28'));
    expect(floorCandidate(d('2024-02-29'), 'NONE', 20)).toEqual(
      d('2044-02-29'),
    );
  });
});

describe('isUnderRetention', () => {
  const now = new Date('2026-10-16T12:00:00.000Z');

  it('sin atenciones: no está en retención (se puede archivar como hoy)', () => {
    expect(isUnderRetention(null, now)).toBe(false);
  });

  it('PERMANENT: siempre', () => {
    expect(isUnderRetention('PERMANENT', now)).toBe(true);
  });

  it('dentro del plazo (incluido el último día): sí', () => {
    expect(isUnderRetention(d('2030-01-01'), now)).toBe(true);
    expect(isUnderRetention(d('2026-10-16'), now)).toBe(true);
  });

  it('vencido: no', () => {
    expect(isUnderRetention(d('2026-10-15'), now)).toBe(false);
  });
});
