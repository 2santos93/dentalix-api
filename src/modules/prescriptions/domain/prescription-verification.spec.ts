import {
  PRESCRIPTION_VERIFICATION_ALPHABET,
  PRESCRIPTION_VERIFICATION_CODE_LENGTH,
  formatPrescriptionVerificationCode,
  generatePrescriptionVerificationCode,
  isPrescriptionVerificationCode,
  normalizePrescriptionVerificationCode,
  patientInitials,
  prescriptionVerificationUrl,
  publicVerificationAuditReason,
} from './prescription-verification';

describe('código de verificación de la receta (DX-467)', () => {
  it('el alfabeto no tiene caracteres ambiguos (0/O, 1/I/L) ni repetidos', () => {
    const ambiguous = new Set(['0', 'O', '1', 'I', 'L']);
    expect(
      [...PRESCRIPTION_VERIFICATION_ALPHABET].filter((c) => ambiguous.has(c)),
    ).toEqual([]);
    expect(new Set(PRESCRIPTION_VERIFICATION_ALPHABET).size).toBe(
      PRESCRIPTION_VERIFICATION_ALPHABET.length,
    );
    expect(PRESCRIPTION_VERIFICATION_ALPHABET).toMatch(/^[2-9A-Z]+$/);
    expect(PRESCRIPTION_VERIFICATION_ALPHABET).toHaveLength(31);
  });

  it('genera códigos de al menos 10 caracteres del alfabeto', () => {
    expect(PRESCRIPTION_VERIFICATION_CODE_LENGTH).toBeGreaterThanOrEqual(10);
    for (let i = 0; i < 200; i += 1) {
      const code = generatePrescriptionVerificationCode();
      expect(code).toHaveLength(PRESCRIPTION_VERIFICATION_CODE_LENGTH);
      expect(isPrescriptionVerificationCode(code)).toBe(true);
    }
  });

  it('usa el generador aleatorio que recibe, un símbolo por llamada y con el alfabeto como tope', () => {
    const calls: number[] = [];
    const code = generatePrescriptionVerificationCode((max) => {
      calls.push(max);
      return calls.length - 1;
    });
    expect(calls).toEqual(
      Array(PRESCRIPTION_VERIFICATION_CODE_LENGTH).fill(
        PRESCRIPTION_VERIFICATION_ALPHABET.length,
      ),
    );
    expect(code).toBe(
      PRESCRIPTION_VERIFICATION_ALPHABET.slice(
        0,
        PRESCRIPTION_VERIFICATION_CODE_LENGTH,
      ),
    );
  });

  it('por defecto es aleatorio de verdad (CSPRNG): 1000 códigos sin repetirse y todos los símbolos salen', () => {
    const codes = new Set<string>();
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const code = generatePrescriptionVerificationCode();
      codes.add(code);
      for (const c of code) seen.add(c);
    }
    expect(codes.size).toBe(1000);
    expect(seen.size).toBe(PRESCRIPTION_VERIFICATION_ALPHABET.length);
  });

  it('rechaza un índice fuera del alfabeto (generador roto): nunca un código corto', () => {
    expect(() => generatePrescriptionVerificationCode(() => 31)).toThrow();
    expect(() => generatePrescriptionVerificationCode(() => -1)).toThrow();
    expect(() => generatePrescriptionVerificationCode(() => 1.5)).toThrow();
  });

  it('normaliza lo que se teclea: minúsculas, guiones y espacios; lo demás no es un código', () => {
    const code = 'K7M2P9QRT4XW';
    expect(normalizePrescriptionVerificationCode(code)).toBe(code);
    expect(normalizePrescriptionVerificationCode('k7m2-p9qr-t4xw')).toBe(code);
    expect(normalizePrescriptionVerificationCode(' K7M2 P9QR T4XW ')).toBe(
      code,
    );
    for (const bad of [
      '',
      'K7M2P9QRT4X',
      'K7M2P9QRT4XWZ',
      'K7M2P9QRT4X0',
      'K7M2P9QRT4XO',
      'K7M2P9QRT4XI',
      'K7M2P9QRT4XL',
      'K7M2P9QRT4X1',
      'K7M2P9QRT4X%',
      'K7M2P9QRT4XÑ',
      `${code}${'-'.repeat(100)}`,
      '00000000-0000-4000-8000-000000000001',
    ]) {
      expect(normalizePrescriptionVerificationCode(bad)).toBeNull();
    }
    expect(isPrescriptionVerificationCode('k7m2p9qrt4xw')).toBe(false);
  });

  it('se imprime en grupos de 4 para leerlo en voz alta', () => {
    expect(formatPrescriptionVerificationCode('K7M2P9QRT4XW')).toBe(
      'K7M2-P9QR-T4XW',
    );
  });

  it('la URL pública es /receta/<código> en el host de la clínica', () => {
    expect(
      prescriptionVerificationUrl('https://demo.dentalix.app', 'K7M2P9QRT4XW'),
    ).toBe('https://demo.dentalix.app/receta/K7M2P9QRT4XW');
  });
});

describe('iniciales del paciente (DX-467)', () => {
  it('una inicial por palabra con mayúscula, con punto', () => {
    expect(patientInitials('Ana Pérez Gómez')).toBe('A. P. G.');
    expect(patientInitials('María de los Ángeles Durán')).toBe('M. Á. D.');
    expect(patientInitials('Jean-Luc  Picard')).toBe('J. L. P.');
    expect(patientInitials('Ölga Ñúñez')).toBe('Ö. Ñ.');
  });

  it('un nombre escrito todo en minúsculas también da sus iniciales', () => {
    expect(patientInitials('ana pérez')).toBe('A. P.');
  });

  it('sin letras, nada (nunca el nombre)', () => {
    expect(patientInitials('  ')).toBe('');
    expect(patientInitials('123')).toBe('');
  });
});

describe('motivo de auditoría de cada verificación (DX-467)', () => {
  it('uno por resultado', () => {
    expect(publicVerificationAuditReason('VALID')).toBe(
      'PRESCRIPTION_VERIFIED',
    );
    expect(publicVerificationAuditReason('VOIDED')).toBe(
      'PRESCRIPTION_VERIFIED_VOIDED',
    );
    expect(publicVerificationAuditReason('UNVERIFIABLE')).toBe(
      'PRESCRIPTION_INTEGRITY_MISMATCH',
    );
  });
});
