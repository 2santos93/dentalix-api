import {
  AGING_BUCKETS,
  addToBuckets,
  ageInDays,
  bucketOf,
  emptyBuckets,
} from './aging';

describe('ageInDays', () => {
  it('cuenta días civiles de calendario entre dos días', () => {
    expect(ageInDays('2026-10-17', '2026-10-17')).toBe(0);
    expect(ageInDays('2026-10-16', '2026-10-17')).toBe(1);
    expect(ageInDays('2026-09-17', '2026-10-17')).toBe(30);
    // Cruza un 29 de febrero.
    expect(ageInDays('2028-02-28', '2028-03-01')).toBe(2);
  });

  it('es negativo para un día futuro', () => {
    expect(ageInDays('2026-10-20', '2026-10-17')).toBe(-3);
  });

  it('rechaza un día que no existe, también la segunda vez (memo)', () => {
    for (let i = 0; i < 2; i++) {
      expect(() => ageInDays('2026-02-30', '2026-10-17')).toThrow(RangeError);
      expect(() => ageInDays('2026-10-17', '17/10/2026')).toThrow(RangeError);
    }
  });

  it('da lo mismo con el memo caliente, en miles de llamadas', () => {
    for (let n = 0; n < 2000; n++) {
      const from = new Date(Date.UTC(2020, 0, 1 + n))
        .toISOString()
        .slice(0, 10);
      expect(ageInDays(from, '2026-10-17')).toBe(
        Math.round(
          (Date.UTC(2026, 9, 17) - Date.UTC(2020, 0, 1 + n)) / 86_400_000,
        ),
      );
    }
  });
});

describe('bucketOf', () => {
  it.each([
    [0, 'days0to30'],
    [30, 'days0to30'],
    [31, 'days31to60'],
    [60, 'days31to60'],
    [61, 'days61to90'],
    [90, 'days61to90'],
    [91, 'over90'],
    [400, 'over90'],
  ] as const)('una deuda exigible de %i días va a %s', (age, bucket) => {
    expect(bucketOf({ ageDays: age, due: true })).toBe(bucket);
  });

  it('una cuota que aún no vence va a «por vencer», sea cual sea su edad', () => {
    expect(bucketOf({ ageDays: 0, due: false })).toBe('current');
    expect(bucketOf({ ageDays: -45, due: false })).toBe('current');
  });
});

describe('addToBuckets', () => {
  it('suma en centavos exactos por tramo', () => {
    const buckets = emptyBuckets();
    addToBuckets(buckets, 'days0to30', 0.1);
    addToBuckets(buckets, 'days0to30', 0.2);
    addToBuckets(buckets, 'over90', 100);
    expect(buckets).toEqual({
      current: 0,
      days0to30: 0.3,
      days31to60: 0,
      days61to90: 0,
      over90: 100,
    });
  });

  it('lista los tramos en orden de antigüedad', () => {
    expect(AGING_BUCKETS).toEqual([
      'current',
      'days0to30',
      'days31to60',
      'days61to90',
      'over90',
    ]);
  });
});
