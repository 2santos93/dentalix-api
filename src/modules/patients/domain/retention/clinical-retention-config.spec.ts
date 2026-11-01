import {
  MAX_RETENTION_YEARS,
  PLATFORM_FLOOR_YEARS,
  loadClinicalRetentionConfig,
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
