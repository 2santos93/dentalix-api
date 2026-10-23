import { formatMoney } from './format-money';

describe('formatMoney', () => {
  it('como la web: separador de miles, dos decimales y la moneda', () => {
    expect(formatMoney(1500000, 'COP')).toMatch(/^1\.500\.000,00\sCOP$/);
    expect(formatMoney(40, 'USD')).toMatch(/^40,00\sUS\$$/);
  });

  it('un código que Intl no conoce no rompe el mensaje', () => {
    expect(formatMoney(10, 'X1')).toBe('X1 10.00');
  });
});
