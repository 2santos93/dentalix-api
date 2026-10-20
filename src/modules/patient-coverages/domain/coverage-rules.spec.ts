import {
  COVERAGE_DATE_FORMAT_MESSAGE,
  COVERAGE_DATE_RANGE_MESSAGE,
  COVERAGE_NOTES_MAX,
  MAX_COVERAGES_PER_PATIENT,
  MEMBER_NUMBER_MAX,
  PLAN_NAME_MAX,
  POLICY_HOLDER_NAME_MAX,
  coverageStatus,
  normalizeCoverageText,
  validateCoverageDates,
} from './coverage-rules';

describe('reglas de cobertura (DX-153)', () => {
  describe('coverageStatus', () => {
    const today = '2026-10-20';

    it('sin fechas es vigente (vigencia indefinida)', () => {
      expect(coverageStatus({ validFrom: null, validTo: null }, today)).toBe(
        'ACTIVE',
      );
    });

    it('dentro de la vigencia, con los extremos incluidos, es ACTIVE', () => {
      expect(
        coverageStatus(
          { validFrom: '2026-01-01', validTo: '2026-12-31' },
          today,
        ),
      ).toBe('ACTIVE');
      expect(coverageStatus({ validFrom: today, validTo: today }, today)).toBe(
        'ACTIVE',
      );
      expect(coverageStatus({ validFrom: null, validTo: today }, today)).toBe(
        'ACTIVE',
      );
    });

    it('validTo anterior a hoy es EXPIRED', () => {
      expect(
        coverageStatus(
          { validFrom: '2025-01-01', validTo: '2026-10-19' },
          today,
        ),
      ).toBe('EXPIRED');
      expect(
        coverageStatus({ validFrom: null, validTo: '2026-10-19' }, today),
      ).toBe('EXPIRED');
    });

    it('validFrom posterior a hoy es NOT_STARTED, con o sin fin', () => {
      expect(
        coverageStatus({ validFrom: '2026-10-21', validTo: null }, today),
      ).toBe('NOT_STARTED');
      expect(
        coverageStatus(
          { validFrom: '2026-10-21', validTo: '2027-10-21' },
          today,
        ),
      ).toBe('NOT_STARTED');
    });
  });

  describe('validateCoverageDates', () => {
    it('acepta vacías, solo una, y fin igual o posterior al inicio', () => {
      expect(validateCoverageDates(null, null)).toBeNull();
      expect(validateCoverageDates('2026-05-01', null)).toBeNull();
      expect(validateCoverageDates(null, '2026-05-01')).toBeNull();
      expect(validateCoverageDates('2026-05-01', '2026-05-01')).toBeNull();
      expect(validateCoverageDates('2026-05-01', '2026-06-01')).toBeNull();
    });

    it('rechaza un fin anterior al inicio', () => {
      expect(validateCoverageDates('2026-05-02', '2026-05-01')).toBe(
        COVERAGE_DATE_RANGE_MESSAGE,
      );
    });

    it('rechaza días que no existen o con otro formato', () => {
      expect(validateCoverageDates('2026-02-30', null)).toBe(
        COVERAGE_DATE_FORMAT_MESSAGE,
      );
      expect(validateCoverageDates(null, '2026-13-01')).toBe(
        COVERAGE_DATE_FORMAT_MESSAGE,
      );
      expect(validateCoverageDates('01/05/2026', null)).toBe(
        COVERAGE_DATE_FORMAT_MESSAGE,
      );
    });
  });

  describe('normalizeCoverageText', () => {
    it('recorta y deja null lo vacío o ausente', () => {
      expect(normalizeCoverageText('  Plan Oro ')).toBe('Plan Oro');
      expect(normalizeCoverageText('   ')).toBeNull();
      expect(normalizeCoverageText('')).toBeNull();
      expect(normalizeCoverageText(null)).toBeNull();
      expect(normalizeCoverageText(undefined)).toBeNull();
    });
  });

  it('los topes de longitud y de coberturas son los de la especificación', () => {
    expect(PLAN_NAME_MAX).toBe(120);
    expect(MEMBER_NUMBER_MAX).toBe(60);
    expect(POLICY_HOLDER_NAME_MAX).toBe(200);
    expect(COVERAGE_NOTES_MAX).toBe(500);
    expect(MAX_COVERAGES_PER_PATIENT).toBe(5);
  });
});
