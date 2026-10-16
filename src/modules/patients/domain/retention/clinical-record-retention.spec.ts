import {
  CLINICAL_RECORD_RETENTION_YEARS,
  isUnderRetention,
  retentionUntil,
} from './clinical-record-retention';

const d = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe('retentionUntil (DX-039, Res. 839/2017)', () => {
  it('sin atenciones clínicas no hay retención', () => {
    expect(retentionUntil(null, 'NONE')).toBeNull();
    expect(retentionUntil(null, 'DOUBLE')).toBeNull();
  });

  it('NONE: 15 años desde la última atención', () => {
    expect(CLINICAL_RECORD_RETENTION_YEARS).toBe(15);
    expect(retentionUntil(d('2020-03-10'), 'NONE')).toEqual(d('2035-03-10'));
  });

  it('DOUBLE: 30 años', () => {
    expect(retentionUntil(d('2020-03-10'), 'DOUBLE')).toEqual(d('2050-03-10'));
  });

  it('PERMANENT: nunca se libera, aunque no haya atenciones', () => {
    expect(retentionUntil(d('1990-01-01'), 'PERMANENT')).toBe('PERMANENT');
    expect(retentionUntil(null, 'PERMANENT')).toBe('PERMANENT');
  });

  it('29 de febrero: termina el 28 de febrero si el año final no es bisiesto', () => {
    expect(retentionUntil(d('2024-02-29'), 'NONE')).toEqual(d('2039-02-28'));
    // 2024 + 30 = 2054, tampoco bisiesto.
    expect(retentionUntil(d('2024-02-29'), 'DOUBLE')).toEqual(d('2054-02-28'));
  });

  it('29 de febrero a última hora: cuenta el día civil y no salta a marzo', () => {
    expect(
      retentionUntil(new Date('2024-02-29T23:59:00.000Z'), 'NONE'),
    ).toEqual(d('2039-02-28'));
    expect(retentionUntil(d('2024-03-01'), 'NONE')).toEqual(d('2039-03-01'));
  });

  it('usa el día civil (UTC) de la atención, sin la hora', () => {
    expect(
      retentionUntil(new Date('2021-06-15T18:30:00.000Z'), 'NONE'),
    ).toEqual(d('2036-06-15'));
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
