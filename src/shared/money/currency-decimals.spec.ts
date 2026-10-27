import { ISO4217_CURRENCIES } from '../../../prisma/reference/iso4217';
import { ZERO_DECIMAL_CURRENCIES, currencyDecimals } from './currency-decimals';

const PREVIOUS_SET = ['COP', 'CLP', 'JPY', 'KRW', 'PYG'];

describe('ZERO_DECIMAL_CURRENCIES', () => {
  it('equals current set ∪ minorUnits=0 of ISO4217_CURRENCIES', () => {
    const expected = new Set([
      ...PREVIOUS_SET,
      ...ISO4217_CURRENCIES.filter((c) => c.minorUnits === 0).map(
        (c) => c.code,
      ),
    ]);
    expect([...ZERO_DECIMAL_CURRENCIES].sort()).toEqual([...expected].sort());
  });

  it('currencyDecimals is 0 for them (any case) and 2 otherwise', () => {
    expect(currencyDecimals('vnd')).toBe(0);
    expect(currencyDecimals('COP')).toBe(0);
    expect(currencyDecimals('EUR')).toBe(2);
  });
});
