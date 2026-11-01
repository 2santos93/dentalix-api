import {
  MAX_RETENTION_YEARS,
  PLATFORM_FLOOR_YEARS,
  loadClinicalRetentionConfig,
  platformMinYearsProblem,
  resolvePlatformMinYears,
} from './clinical-retention-config';

describe('loadClinicalRetentionConfig (DX-330)', () => {
  it('uses the platform floor when the variable is empty or missing', () => {
    expect(loadClinicalRetentionConfig(() => undefined)).toEqual({
      platformMinYears: 15,
    });
    expect(loadClinicalRetentionConfig(() => '')).toEqual({
      platformMinYears: 15,
    });
  });

  it('reads the validated variable', () => {
    expect(
      loadClinicalRetentionConfig((key) =>
        key === 'PLATFORM_MIN_CLINICAL_RETENTION_YEARS' ? '20' : undefined,
      ),
    ).toEqual({ platformMinYears: 20 });
  });

  it('exposes the floor and the ceiling of the term', () => {
    expect(PLATFORM_FLOOR_YEARS).toBe(15);
    expect(MAX_RETENTION_YEARS).toBe(100);
  });
});

describe('resolvePlatformMinYears (DX-330, script sin validateEnv)', () => {
  const of = (value: string | undefined) => (key: string) =>
    key === 'PLATFORM_MIN_CLINICAL_RETENTION_YEARS' ? value : undefined;

  it.each([undefined, ''])(
    'treats %j as the platform floor, like the boot',
    (v) => {
      expect(resolvePlatformMinYears(of(v))).toBe(15);
    },
  );

  it.each([
    ['15', 15],
    ['20', 20],
    ['100', 100],
  ])('accepts %s', (v, n) => {
    expect(resolvePlatformMinYears(of(v))).toBe(n);
  });

  it.each(['200', '101', '14', 'abc', '20.5', '1000', ' ', '-20'])(
    'rejects %j instead of clamping or falling back',
    (v) => {
      expect(() => resolvePlatformMinYears(of(v))).toThrow(
        'PLATFORM_MIN_CLINICAL_RETENTION_YEARS debe ser un entero entre 15 y 100.',
      );
      expect(platformMinYearsProblem(v)).not.toBeNull();
    },
  );
});
