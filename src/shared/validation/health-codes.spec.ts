import {
  CUPS_FORMAT_MESSAGE,
  ICD10_INVALID_MESSAGE,
  REPS_FORMAT_MESSAGE,
  isValidCupsCode,
  isValidIcd10Format,
  isValidRepsCode,
  normalizeCupsCode,
  normalizeIcd10Code,
  normalizeRepsCode,
} from './health-codes';

describe('códigos de salud (DX-212)', () => {
  describe('CUPS', () => {
    it.each(['890203', '232101', 'A1B2C3'])('acepta %s', (code) => {
      expect(isValidCupsCode(code)).toBe(true);
    });

    it.each(['89020', '8902034', '89-203', '89020 ', '', 'ab12c$'])(
      'rechaza «%s»',
      (code) => {
        expect(isValidCupsCode(code)).toBe(false);
      },
    );

    it('normaliza espacios y minúsculas; vacío = quitar el código', () => {
      expect(normalizeCupsCode(' a1b2c3 ')).toBe('A1B2C3');
      expect(normalizeCupsCode('   ')).toBeNull();
      expect(normalizeCupsCode(null)).toBeNull();
      expect(normalizeCupsCode(undefined)).toBeUndefined();
    });

    it('el mensaje dice el formato esperado', () => {
      expect(CUPS_FORMAT_MESSAGE).toMatch(/6 caracteres alfanuméricos/);
    });
  });

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
