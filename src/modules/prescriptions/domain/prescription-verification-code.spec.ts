import {
  PRESCRIPTION_VERIFICATION_ALPHABET,
  PRESCRIPTION_VERIFICATION_CODE_LENGTH,
  formatPrescriptionVerificationCode,
  generatePrescriptionVerificationCode,
  normalizePrescriptionVerificationCode,
} from './prescription-verification-code';

describe('código de verificación de la receta (DX-467)', () => {
  it('el alfabeto no tiene símbolos ambiguos (0/O, 1/I/L) ni repetidos', () => {
    expect(PRESCRIPTION_VERIFICATION_ALPHABET).toHaveLength(31);
    expect(PRESCRIPTION_VERIFICATION_ALPHABET).toMatch(/^[^0O1IL]+$/);
    expect(new Set(PRESCRIPTION_VERIFICATION_ALPHABET).size).toBe(31);
  });

  it('genera 12 símbolos (≥ 10) del alfabeto', () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePrescriptionVerificationCode();
      expect(code).toHaveLength(PRESCRIPTION_VERIFICATION_CODE_LENGTH);
      expect(PRESCRIPTION_VERIFICATION_CODE_LENGTH).toBeGreaterThanOrEqual(10);
      expect(code).toMatch(/^[2-9A-HJKMNP-Z]{12}$/);
    }
  });

  it('no se repite en 10 000 códigos y usa todo el alfabeto', () => {
    const codes = new Set<string>();
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const code = generatePrescriptionVerificationCode();
      codes.add(code);
      for (const ch of code) seen.add(ch);
    }
    expect(codes.size).toBe(10_000);
    expect(seen.size).toBe(31);
  });

  it('cada símbolo sale del generador aleatorio, con el tamaño del alfabeto', () => {
    const calls: number[] = [];
    const code = generatePrescriptionVerificationCode((max) => {
      calls.push(max);
      return calls.length - 1;
    });
    expect(calls).toEqual(Array(12).fill(31));
    expect(code).toBe(PRESCRIPTION_VERIFICATION_ALPHABET.slice(0, 12));
  });

  it('normaliza la agrupación impresa y las minúsculas', () => {
    expect(normalizePrescriptionVerificationCode('abcd-efgh-jkmn')).toBe(
      'ABCDEFGHJKMN',
    );
    expect(normalizePrescriptionVerificationCode(' ABCD EFGH JKMN ')).toBe(
      'ABCDEFGHJKMN',
    );
  });

  it.each([
    ['vacío', ''],
    ['corto', 'ABCDEFGHJKM'],
    ['largo', 'ABCDEFGHJKMNP'],
    ['con 0', 'ABCDEFGHJKM0'],
    ['con O', 'ABCDEFGHJKMO'],
    ['con 1', 'ABCDEFGHJKM1'],
    ['con I', 'ABCDEFGHJKMI'],
    ['con L', 'ABCDEFGHJKML'],
    ['un uuid', '3f1c2a9e-5b7d-4c1a-9f2e-8d6b4a3c2e1f'],
    ['basura enorme', 'A'.repeat(500)],
    ['otros símbolos', 'ABCD/EFGH.JK'],
  ])('rechaza %s', (_label, raw) => {
    expect(normalizePrescriptionVerificationCode(raw)).toBeNull();
  });

  it('agrupa de 4 en 4 para el papel', () => {
    expect(formatPrescriptionVerificationCode('ABCDEFGHJKMN')).toBe(
      'ABCD-EFGH-JKMN',
    );
  });
});
