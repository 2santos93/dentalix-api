import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ISO4217_CURRENCIES } from '../../../prisma/reference/iso4217';
import { CURRENCY_DIGITS } from '../../../prisma/reference/currency-digits';
import { CLDR_ZERO_FORMAT_DIGITS } from './cldr-format-digits';

const cldrDigitsZero = ISO4217_CURRENCIES.filter((c) => c.cldrDigits === 0).map(
  (c) => c.code,
);

describe('dígitos de formato CLDR (DX-340)', () => {
  it('el JSON que copia la web es la derivación de iso4217.ts, fijada en CLDR 47', () => {
    const json: unknown = JSON.parse(
      readFileSync(
        join(
          __dirname,
          '../../../prisma/reference/cldr-format-digits-zero.json',
        ),
        'utf8',
      ),
    );
    expect(json).toEqual({ cldr: '47.0', cldrDigitsZero });
    expect(
      readFileSync(
        join(__dirname, '../../../prisma/reference/iso4217.ts'),
        'utf8',
      ),
    ).toContain('CLDR 47.0');
  });

  it('CLDR_ZERO_FORMAT_DIGITS es esa lista', () => {
    expect([...CLDR_ZERO_FORMAT_DIGITS].sort()).toEqual(
      [...cldrDigitsZero].sort(),
    );
  });

  it('formato, minor units ISO y redondeo son números distintos (RSD, COP, JPY)', () => {
    const of = (code: string) => CURRENCY_DIGITS.find((c) => c.code === code);
    // RSD: se pinta sin decimales (CLDR 47), ISO le da 2 y se redondea a 0.
    expect(CLDR_ZERO_FORMAT_DIGITS.has('RSD')).toBe(true);
    expect(of('RSD')).toEqual({
      code: 'RSD',
      minorUnits: 2,
      roundingDigits: 0,
    });
    // COP: se pinta con 2 (CLDR 47), ISO 2, se redondea al peso (legado).
    expect(CLDR_ZERO_FORMAT_DIGITS.has('COP')).toBe(false);
    expect(of('COP')).toEqual({
      code: 'COP',
      minorUnits: 2,
      roundingDigits: 0,
    });
    // JPY: 0 en los tres.
    expect(CLDR_ZERO_FORMAT_DIGITS.has('JPY')).toBe(true);
    expect(of('JPY')).toEqual({
      code: 'JPY',
      minorUnits: 0,
      roundingDigits: 0,
    });
  });

  it('la regla de redondeo congelada es la lista anterior a DX-340 (sin cambios)', () => {
    // ZERO_DECIMAL_CURRENCIES de la API y la web antes de DX-340: CLDR 47 ∪
    // conjunto anterior a G1. Ningún descuento ni precio nuevo cambia.
    const previous = new Set([
      ...cldrDigitsZero,
      'COP',
      'CLP',
      'JPY',
      'KRW',
      'PYG',
    ]);
    expect(
      CURRENCY_DIGITS.filter((c) => c.roundingDigits === 0)
        .map((c) => c.code)
        .sort(),
    ).toEqual([...previous].sort());
    expect(CURRENCY_DIGITS.every((c) => c.roundingDigits <= c.minorUnits)).toBe(
      true,
    );
    expect(CURRENCY_DIGITS.map((c) => c.code)).toEqual(
      ISO4217_CURRENCIES.map((c) => c.code),
    );
  });
});
