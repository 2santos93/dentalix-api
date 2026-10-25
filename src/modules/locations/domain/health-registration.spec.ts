import {
  HEALTH_REGISTRATION_NUMBER_MAX,
  healthRegistrationChange,
  normalizeHealthRegistrationNumber,
} from './health-registration';

describe('nº de registro sanitario de la sede (DX-319)', () => {
  describe('normalizeHealthRegistrationNumber', () => {
    it('recorta; vacío o null lo quitan; ausente no lo toca', () => {
      expect(normalizeHealthRegistrationNumber('  NRS 28/1234-AB  ')).toBe(
        'NRS 28/1234-AB',
      );
      expect(normalizeHealthRegistrationNumber('   ')).toBeNull();
      expect(normalizeHealthRegistrationNumber('')).toBeNull();
      expect(normalizeHealthRegistrationNumber(null)).toBeNull();
      expect(normalizeHealthRegistrationNumber(undefined)).toBeUndefined();
    });

    it('no valida formato ni país: cualquier texto vale', () => {
      for (const value of [
        '110010123401',
        'CS-12.345',
        'Reg. sanitario nº 7',
      ]) {
        expect(normalizeHealthRegistrationNumber(value)).toBe(value);
      }
    });

    it('el tope es de 64 caracteres', () => {
      expect(HEALTH_REGISTRATION_NUMBER_MAX).toBe(64);
    });
  });

  describe('healthRegistrationChange', () => {
    const side = (number: string | null, shown = false) => ({
      healthRegistrationNumber: number,
      showHealthRegistrationNumber: shown,
    });

    it('null si no cambia nada', () => {
      expect(healthRegistrationChange(side('A1'), side('A1'))).toBeNull();
      expect(healthRegistrationChange(side(null), side(null))).toBeNull();
    });

    it('antes y después del número y de si se imprime', () => {
      expect(healthRegistrationChange(side(null), side('A1', true))).toEqual({
        before: { number: null, shown: false },
        after: { number: 'A1', shown: true },
      });
      expect(healthRegistrationChange(side('A1', true), side('A1'))).toEqual({
        before: { number: 'A1', shown: true },
        after: { number: 'A1', shown: false },
      });
    });
  });
});
