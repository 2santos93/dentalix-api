import { CURRENCY_DIGITS } from '../../../prisma/reference/currency-digits';
import { CLDR_ZERO_FORMAT_DIGITS } from '../format/cldr-format-digits';
import { csvAmount } from './csv-cells';

/**
 * DX-488: un importe en un CSV sale con los decimales de la PANTALLA
 * (`moneyWithCode` de la web): 0 solo si el importe es entero y su moneda se
 * pinta sin decimales (CLDR); si no, 2. Nunca con `roundingDigits`, que es el
 * redondeo de los descuentos y no debe comerse céntimos guardados.
 */
describe('csvAmount: los decimales de la pantalla (DX-488)', () => {
  it('USD y VES siempre con 2 decimales', () => {
    expect(csvAmount(10.5, 'USD')).toBe('10.50');
    expect(csvAmount(1200, 'USD')).toBe('1200.00');
    expect(csvAmount(36.5, 'VES')).toBe('36.50');
    expect(csvAmount(0, 'VES')).toBe('0.00');
    expect(csvAmount(-10.5, 'USD')).toBe('-10.50');
  });

  it('JPY entero sin decimales; con céntimos guardados, con 2', () => {
    expect(csvAmount(1000, 'JPY')).toBe('1000');
    expect(csvAmount(1000.5, 'JPY')).toBe('1000.50');
    expect(csvAmount(0, 'jpy')).toBe('0');
  });

  it('una moneda de redondeo 0 no se come los céntimos guardados: RSD 150000.50', () => {
    expect(csvAmount(150000.5, 'RSD')).toBe('150000.50');
    expect(csvAmount(0.45, 'RSD')).toBe('0.45');
    expect(csvAmount(150000, 'RSD')).toBe('150000');
  });

  it('para toda moneda del catálogo: 0 decimales solo si se pinta sin decimales y el importe es entero', () => {
    for (const { code } of CURRENCY_DIGITS) {
      const zero = CLDR_ZERO_FORMAT_DIGITS.has(code);
      expect(csvAmount(1500, code)).toBe(zero ? '1500' : '1500.00');
      expect(csvAmount(1500.05, code)).toBe('1500.05');
    }
  });
});
