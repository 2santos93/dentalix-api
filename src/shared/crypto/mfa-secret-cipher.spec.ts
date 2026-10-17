import { randomBytes } from 'node:crypto';
import {
  MfaSecretCipher,
  loadMfaMasterKey,
  parseMfaEncryptionKey,
} from './mfa-secret-cipher';

const USER = '6f0c3f9e-7d1b-4c2a-9e1f-0a1b2c3d4e5f';
const OTHER = '0b9d1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4';

describe('MfaSecretCipher (SEC-008)', () => {
  const cipher = new MfaSecretCipher(randomBytes(32));

  it('cifra y descifra; el texto en claro no aparece en lo guardado', () => {
    const stored = cipher.encrypt('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', USER);
    expect(stored).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(stored).not.toContain('JBSWY3DP');
    expect(cipher.decrypt(stored, USER)).toBe(
      'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    );
  });

  it('dos cifrados del mismo secreto son distintos (IV aleatorio)', () => {
    expect(cipher.encrypt('ABC', USER)).not.toBe(cipher.encrypt('ABC', USER));
  });

  it('no descifra con el id de otro usuario (AAD)', () => {
    const stored = cipher.encrypt('ABC', USER);
    expect(() => cipher.decrypt(stored, OTHER)).toThrow();
  });

  it('no descifra con otra clave ni si se altera', () => {
    const stored = cipher.encrypt('ABC', USER);
    expect(() =>
      new MfaSecretCipher(randomBytes(32)).decrypt(stored, USER),
    ).toThrow();
    const tampered = stored.slice(0, -2) + (stored.endsWith('A') ? 'BB' : 'AA');
    expect(() => cipher.decrypt(tampered, USER)).toThrow();
    expect(() => cipher.decrypt('v2.xxx', USER)).toThrow();
  });

  it('exige una clave de 32 bytes', () => {
    expect(() => new MfaSecretCipher(randomBytes(16))).toThrow();
  });

  describe('clave', () => {
    const hex = 'a1'.repeat(16) + 'b2c3d4e5'.repeat(4);

    it('acepta 32 bytes en hex o base64; rechaza el resto', () => {
      expect(parseMfaEncryptionKey(hex)).toHaveLength(32);
      expect(
        parseMfaEncryptionKey(Buffer.from(hex, 'hex').toString('base64')),
      ).toHaveLength(32);
      expect(parseMfaEncryptionKey('corta')).toBeNull();
      expect(parseMfaEncryptionKey(undefined)).toBeNull();
    });

    it('en producción la exige; fuera, la deriva de JWT_ACCESS_SECRET (estable)', () => {
      const env = (vars: Record<string, string>) => (k: string) => vars[k];
      expect(() =>
        loadMfaMasterKey(
          env({ NODE_ENV: 'production', JWT_ACCESS_SECRET: 'x'.repeat(40) }),
        ),
      ).toThrow(/MFA_ENCRYPTION_KEY/);
      const a = loadMfaMasterKey(env({ JWT_ACCESS_SECRET: 's'.repeat(40) }));
      const b = loadMfaMasterKey(env({ JWT_ACCESS_SECRET: 's'.repeat(40) }));
      expect(a.equals(b)).toBe(true);
      expect(a).toHaveLength(32);
      expect(
        loadMfaMasterKey(env({ MFA_ENCRYPTION_KEY: hex })).toString('hex'),
      ).toBe(hex);
    });
  });
});
