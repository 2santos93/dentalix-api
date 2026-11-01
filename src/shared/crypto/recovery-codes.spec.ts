import { randomBytes } from 'node:crypto';
import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCode,
  generateRecoveryCodes,
  normalizeRecoveryCode,
} from './recovery-codes';
import { MfaSecretCipher } from './mfa-secret-cipher';

describe('códigos de recuperación (DX-021)', () => {
  it('genera 10 códigos distintos con formato XXXX-XXXX-XXXX-XXXX (80 bits)', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    }
  });

  it('normaliza lo que se teclea (minúsculas, espacios, guiones)', () => {
    const code = generateRecoveryCode();
    const canonical = code.replace(/-/g, '');
    expect(normalizeRecoveryCode(code)).toBe(canonical);
    expect(normalizeRecoveryCode(` ${code.toLowerCase()} `)).toBe(canonical);
    expect(normalizeRecoveryCode(canonical.match(/.{4}/g)!.join(' '))).toBe(
      canonical,
    );
  });

  it('rechaza lo que no es un código (longitud o alfabeto)', () => {
    expect(normalizeRecoveryCode('')).toBeNull();
    expect(normalizeRecoveryCode('123456')).toBeNull();
    expect(normalizeRecoveryCode('ABCD-EFGH-IJKL-MNO')).toBeNull();
    expect(normalizeRecoveryCode('ABCD-EFGH-IJKL-MN01')).toBeNull();
  });

  it('la huella es un HMAC hex de 64, ligada al usuario y a la clave', () => {
    const key = randomBytes(32);
    const cipher = new MfaSecretCipher(key);
    const code = normalizeRecoveryCode(generateRecoveryCode())!;
    const hash = cipher.hashRecoveryCode(code, 'user-a');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(cipher.hashRecoveryCode(code, 'user-a')).toBe(hash);
    expect(cipher.hashRecoveryCode(code, 'user-b')).not.toBe(hash);
    expect(
      new MfaSecretCipher(randomBytes(32)).hashRecoveryCode(code, 'user-a'),
    ).not.toBe(hash);
    // Nunca contiene el código en claro.
    expect(hash).not.toContain(code.toLowerCase());
  });
});
