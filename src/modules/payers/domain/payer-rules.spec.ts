import {
  normalizePayerName,
  PAYER_NAME_MESSAGE,
  payerNameKey,
  validatePayerName,
} from './payer-rules';

describe('reglas de pagadores (DX-153)', () => {
  describe('nombre', () => {
    it.each(['Sanavida', 'AB', 'x'.repeat(120), '  Surco  '])(
      'acepta %j',
      (name) => {
        expect(validatePayerName(name)).toBeNull();
      },
    );

    it.each(['', ' ', 'A', '  A  ', 'x'.repeat(121)])('rechaza %j', (name) => {
      expect(validatePayerName(name)).toBe(PAYER_NAME_MESSAGE);
    });

    it('normaliza espacios de los extremos y los internos', () => {
      expect(normalizePayerName('  Seguros   Bolívar \t S.A. ')).toBe(
        'Seguros Bolívar S.A.',
      );
    });

    it('la clave ignora mayúsculas, tildes y espacios de más', () => {
      expect(payerNameKey('  SEGUROS   Bolívar ')).toBe('seguros bolivar');
      expect(payerNameKey('Adeslas')).toBe(payerNameKey('ADESLAS'));
      expect(payerNameKey('Nueva Salud')).not.toBe(payerNameKey('NuevaEPS'));
    });
  });
});
