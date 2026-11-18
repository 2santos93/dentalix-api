import {
  FORM_MAX_AGE_SECONDS,
  FORM_MIN_FILL_SECONDS,
  bookingCodeMatches,
  checkFormToken,
  deriveBookingKey,
  generateBookingCode,
  generateSessionToken,
  hashSessionToken,
  hmacBookingCode,
  honeypotTripped,
  isWellFormedSessionToken,
  issueFormToken,
} from './booking-security';

const key = deriveBookingKey('secreto-de-prueba', 'code');
const formKey = deriveBookingKey('secreto-de-prueba', 'form');

describe('seguridad de la reserva online (DX-016)', () => {
  it('el código son 6 dígitos y solo casa con su verificación', () => {
    const code = generateBookingCode();
    expect(code).toMatch(/^\d{6}$/);
    const stored = hmacBookingCode(key, 'v1', code);
    expect(bookingCodeMatches(key, 'v1', code, stored)).toBe(true);
    expect(bookingCodeMatches(key, 'v2', code, stored)).toBe(false);
    expect(bookingCodeMatches(key, 'v1', '12345', stored)).toBe(false);
    expect(bookingCodeMatches(key, 'v1', code, null)).toBe(false);
    // Otra clave (otro propósito) no vale.
    expect(
      bookingCodeMatches(
        deriveBookingKey('secreto-de-prueba', 'form'),
        'v1',
        code,
        stored,
      ),
    ).toBe(false);
  });

  it('la sesión es un token opaco de 43 caracteres; se guarda solo su hash', () => {
    const token = generateSessionToken();
    expect(isWellFormedSessionToken(token)).toBe(true);
    expect(isWellFormedSessionToken('corto')).toBe(false);
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('token del formulario (tiempo mínimo de rellenado)', () => {
    const issued = new Date('2026-11-20T12:00:00Z');
    const token = issueFormToken(formKey, 'tenant-a', issued);
    const after = (s: number) => new Date(issued.getTime() + s * 1000);

    it('demasiado rápido, a tiempo y caducado', () => {
      expect(checkFormToken(formKey, 'tenant-a', token, after(1))).toBe(
        'TOO_FAST',
      );
      expect(
        checkFormToken(
          formKey,
          'tenant-a',
          token,
          after(FORM_MIN_FILL_SECONDS),
        ),
      ).toBe('OK');
      expect(
        checkFormToken(
          formKey,
          'tenant-a',
          token,
          after(FORM_MAX_AGE_SECONDS + 1),
        ),
      ).toBe('EXPIRED');
    });

    it('el de otra clínica, alterado o con otra forma no vale', () => {
      expect(checkFormToken(formKey, 'tenant-b', token, after(10))).toBe(
        'INVALID',
      );
      const [ts, mac] = token.split('.');
      expect(
        checkFormToken(
          formKey,
          'tenant-a',
          `${Number(ts) - 60_000}.${mac}`,
          after(10),
        ),
      ).toBe('INVALID');
      expect(checkFormToken(formKey, 'tenant-a', undefined, after(10))).toBe(
        'INVALID',
      );
      expect(checkFormToken(formKey, 'tenant-a', 'a.b.c', after(10))).toBe(
        'INVALID',
      );
    });
  });

  it('el campo trampa solo salta si trae algo', () => {
    expect(honeypotTripped(undefined)).toBe(false);
    expect(honeypotTripped('')).toBe(false);
    expect(honeypotTripped('   ')).toBe(false);
    expect(honeypotTripped('https://spam.example')).toBe(true);
    expect(honeypotTripped(0)).toBe(true);
  });
});
