import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ISO4217_CURRENCIES } from '../../../prisma/reference/iso4217';
import {
  ISO_ZERO_DECIMAL_CURRENCIES,
  ZERO_DECIMAL_CURRENCIES,
  currencyDecimals,
} from './currency-decimals';

const PREVIOUS_SET = ['COP', 'CLP', 'JPY', 'KRW', 'PYG'];

const minorUnitsZero = ISO4217_CURRENCIES.filter((c) => c.minorUnits === 0).map(
  (c) => c.code,
);

describe('zero-decimal currencies', () => {
  it('zero-decimal JSON equals the derivation from ISO4217_CURRENCIES', () => {
    const json: unknown = JSON.parse(
      readFileSync(
        join(__dirname, '../../../prisma/reference/iso4217-zero-decimal.json'),
        'utf8',
      ),
    );
    expect(json).toEqual({
      minorUnitsZero,
      previousSet: PREVIOUS_SET,
    });
  });

  it('ISO_ZERO_DECIMAL_CURRENCIES equals minorUnitsZero', () => {
    expect([...ISO_ZERO_DECIMAL_CURRENCIES].sort()).toEqual(
      [...minorUnitsZero].sort(),
    );
  });

  it('ZERO_DECIMAL_CURRENCIES equals the union', () => {
    const expected = new Set([...PREVIOUS_SET, ...minorUnitsZero]);
    expect([...ZERO_DECIMAL_CURRENCIES].sort()).toEqual([...expected].sort());
  });

  it('currencyDecimals is 0 for them (any case) and 2 otherwise', () => {
    expect(currencyDecimals('vnd')).toBe(0);
    expect(currencyDecimals('COP')).toBe(0);
    expect(currencyDecimals('EUR')).toBe(2);
  });
});
