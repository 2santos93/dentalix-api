import { ClinicCountry, PayerType } from '@prisma/client';
import {
  normalizePayerName,
  PAYER_NAME_MESSAGE,
  PAYER_TYPE_COUNTRY_MESSAGE,
  payerNameKey,
  validatePayerName,
  validatePayerTypeCountry,
} from './payer-rules';

describe('reglas de pagadores (DX-153)', () => {
  describe('nombre', () => {
    it.each(['Sanitas', 'AB', 'x'.repeat(120), '  Sura  '])(
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
      expect(payerNameKey('Nueva EPS')).not.toBe(payerNameKey('NuevaEPS'));
    });
  });

  describe('tipo y país', () => {
    it.each([
      [PayerType.MUTUA_ES, ClinicCountry.ES],
      [PayerType.PREPAGADA_CO, ClinicCountry.CO],
      [PayerType.EPS_CO, ClinicCountry.CO],
      [PayerType.EMPRESA, ClinicCountry.CO],
      [PayerType.EMPRESA, ClinicCountry.ES],
      [PayerType.EMPRESA, null],
      [PayerType.OTRO, ClinicCountry.CO],
      [PayerType.OTRO, ClinicCountry.ES],
      [PayerType.OTRO, null],
    ])('acepta %s con %s', (type, country) => {
      expect(validatePayerTypeCountry(type, country)).toBeNull();
    });

    it.each([
      [PayerType.MUTUA_ES, ClinicCountry.CO],
      [PayerType.MUTUA_ES, null],
      [PayerType.PREPAGADA_CO, ClinicCountry.ES],
      [PayerType.PREPAGADA_CO, null],
      [PayerType.EPS_CO, ClinicCountry.ES],
      [PayerType.EPS_CO, undefined],
    ])('rechaza %s con %s', (type, country) => {
      expect(validatePayerTypeCountry(type, country)).toBe(
        PAYER_TYPE_COUNTRY_MESSAGE,
      );
    });
  });
});
