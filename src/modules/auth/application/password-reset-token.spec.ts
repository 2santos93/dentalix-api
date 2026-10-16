import {
  PASSWORD_RESET_TTL_MINUTES,
  generatePasswordResetToken,
  hashPasswordResetToken,
  isWellFormedPasswordResetToken,
  passwordResetExpiresAt,
  passwordResetTokenStatus,
} from './password-reset-token';

describe('token de restablecimiento de contraseña', () => {
  it('son 32 bytes aleatorios en base64url y no se repiten', () => {
    const a = generatePasswordResetToken();
    const b = generatePasswordResetToken();
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(isWellFormedPasswordResetToken(a)).toBe(true);
  });

  it('el hash es SHA-256 en hex, estable y distinto del token', () => {
    const token = generatePasswordResetToken();
    const hash = hashPasswordResetToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPasswordResetToken(token)).toBe(hash);
    expect(hash).not.toContain(token);
  });

  it('rechaza tokens con otra forma', () => {
    for (const bad of ['', 'abc', 'a'.repeat(44), `${'a'.repeat(42)}=`, 42]) {
      expect(isWellFormedPasswordResetToken(bad)).toBe(false);
    }
  });

  it('caduca a los 30 minutos', () => {
    const now = new Date('2026-10-16T10:00:00Z');
    expect(PASSWORD_RESET_TTL_MINUTES).toBe(30);
    expect(passwordResetExpiresAt(now).toISOString()).toBe(
      '2026-10-16T10:30:00.000Z',
    );
  });

  describe('estado', () => {
    const now = new Date('2026-10-16T10:00:00Z');
    const later = new Date('2026-10-16T10:10:00Z');
    const base = { expiresAt: later, usedAt: null, invalidatedAt: null };

    it('inexistente → INVALID', () => {
      expect(passwordResetTokenStatus(null, now)).toBe('INVALID');
    });
    it('vigente → VALID', () => {
      expect(passwordResetTokenStatus(base, now)).toBe('VALID');
    });
    it('caducado (justo en el límite incluido) → EXPIRED', () => {
      expect(passwordResetTokenStatus(base, later)).toBe('EXPIRED');
    });
    it('reemplazado por otro → INVALID', () => {
      expect(
        passwordResetTokenStatus({ ...base, invalidatedAt: now }, now),
      ).toBe('INVALID');
    });
    it('usado gana a caducado y a reemplazado → USED', () => {
      expect(
        passwordResetTokenStatus(
          { expiresAt: now, usedAt: now, invalidatedAt: now },
          later,
        ),
      ).toBe('USED');
    });
  });
});
