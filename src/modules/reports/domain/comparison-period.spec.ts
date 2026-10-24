import { comparisonPeriod, shiftCivilYears } from './comparison-period';

describe('comparisonPeriod (DX-014)', () => {
  it('«período anterior»: misma longitud, inmediatamente antes', () => {
    expect(comparisonPeriod('2026-10-01', '2026-10-31', 'previous')).toEqual({
      from: '2026-08-31',
      to: '2026-09-30',
    });
    expect(comparisonPeriod('2026-10-24', '2026-10-24', 'previous')).toEqual({
      from: '2026-10-23',
      to: '2026-10-23',
    });
    expect(comparisonPeriod('2026-01-01', '2026-12-31', 'previous')).toEqual({
      from: '2025-01-01',
      to: '2025-12-31',
    });
  });

  it('«mismo período del año anterior»', () => {
    expect(
      comparisonPeriod('2026-10-01', '2026-10-24', 'previous_year'),
    ).toEqual({ from: '2025-10-01', to: '2025-10-24' });
  });

  it('el 29 de febrero pasa al 28 en un año no bisiesto', () => {
    expect(
      comparisonPeriod('2028-02-01', '2028-02-29', 'previous_year'),
    ).toEqual({ from: '2027-02-01', to: '2027-02-28' });
    expect(shiftCivilYears('2028-02-29', -1)).toBe('2027-02-28');
    expect(shiftCivilYears('2027-03-01', -1)).toBe('2026-03-01');
  });

  it('«sin comparación»: null', () => {
    expect(comparisonPeriod('2026-10-01', '2026-10-31', 'none')).toBeNull();
  });
});
