import { CURRENCY_DIGITS } from '../../../prisma/reference/currency-digits';

/**
 * DX-488, decisión 1 (tomada, README «Redondeo de importes»): la unidad de
 * redondeo de una línea es la unidad más pequeña EN USO de la moneda. Estas 13
 * monedas tienen 2 minor units en ISO 4217 pero ninguna fracción en uso, y se
 * quedan con `roundingDigits` 0. Si esta prueba falla es que alguien cambió
 * `prisma/reference/currency-digits.ts` (o su generador): cambiar los dígitos
 * de una moneda es una decisión de producto con su propia migración de datos,
 * no un efecto de regenerar la referencia. Actualiza esta lista solo con esa
 * decisión tomada y el README al día.
 */
const MINOR_UNITS_2_ROUNDING_0 = [
  'AFN',
  'ALL',
  'COP',
  'IRR',
  'KPW',
  'LAK',
  'LBP',
  'MGA',
  'MMK',
  'RSD',
  'SOS',
  'SYP',
  'YER',
];

const codes = (filter: (c: (typeof CURRENCY_DIGITS)[number]) => boolean) =>
  CURRENCY_DIGITS.filter(filter)
    .map((c) => c.code)
    .sort();

describe('dígitos de redondeo 0 en monedas con 2 minor units ISO (DX-488, decisión 1)', () => {
  it('son exactamente estas 13, fijadas a propósito', () => {
    expect(codes((c) => c.minorUnits === 2 && c.roundingDigits === 0)).toEqual(
      MINOR_UNITS_2_ROUNDING_0,
    );
    expect(MINOR_UNITS_2_ROUNDING_0).toHaveLength(13);
  });

  it('toda moneda sin minor units ISO redondea a 0, y ninguna a 1', () => {
    expect(codes((c) => c.minorUnits === 0 && c.roundingDigits !== 0)).toEqual(
      [],
    );
    expect(codes((c) => c.roundingDigits === 1)).toEqual([]);
  });

  it('USD y VES siguen a céntimos (2 y 2)', () => {
    for (const code of ['USD', 'VES']) {
      expect(CURRENCY_DIGITS.find((c) => c.code === code)).toEqual({
        code,
        minorUnits: 2,
        roundingDigits: 2,
      });
    }
  });
});
