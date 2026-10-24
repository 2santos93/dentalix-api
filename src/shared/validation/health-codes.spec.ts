import {
  ICD10_INVALID_MESSAGE,
  REPS_FORMAT_MESSAGE,
  isValidIcd10Format,
  isValidRepsCode,
  normalizeIcd10Code,
  normalizeRepsCode,
} from './health-codes';

describe('códigos de salud (DX-212)', () => {
  describe('REPS', () => {
    it('acepta 12 dígitos', () => {
      expect(isValidRepsCode('110010123401')).toBe(true);
    });

    it.each(['11001012340', '1100101234012', '11001012340A', ''])(
      'rechaza «%s»',
      (code) => {
        expect(isValidRepsCode(code)).toBe(false);
      },
    );

    it('normaliza espacios; vacío = quitar el código', () => {
      expect(normalizeRepsCode(' 110010123401 ')).toBe('110010123401');
      expect(normalizeRepsCode('')).toBeNull();
      expect(normalizeRepsCode(undefined)).toBeUndefined();
    });

    it('el mensaje dice el formato esperado', () => {
      expect(REPS_FORMAT_MESSAGE).toMatch(/12 dígitos/);
    });
  });

  describe('CIE-10', () => {
    it.each(['K02.1', 'Z01.2', 'K05.10'])('formato válido %s', (code) => {
      expect(isValidIcd10Format(code)).toBe(true);
    });

    it.each(['K2.1', 'KK2.1', 'K02.', '02.1', 'K02-1', ''])(
      'formato inválido «%s»',
      (code) => {
        expect(isValidIcd10Format(code)).toBe(false);
      },
    );

    it('normaliza minúsculas, espacios y el punto que falta', () => {
      expect(normalizeIcd10Code(' k02.1 ')).toBe('K02.1');
      expect(normalizeIcd10Code('K021')).toBe('K02.1');
      expect(normalizeIcd10Code('k05')).toBe('K05');
    });

    it('mensaje en español', () => {
      expect(ICD10_INVALID_MESSAGE).toBe('Código CIE-10 no válido');
    });
  });
});
