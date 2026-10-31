import {
  SIGNATURE_CODE_MAX_ATTEMPTS,
  SIGNATURE_CODE_MAX_SENDS,
  SIGNATURE_CODE_RESEND_SECONDS,
  SIGNATURE_CODE_TTL_MINUTES,
  codeResendWaitSeconds,
  deriveSignatureCodeKey,
  generateSignatureCode,
  hmacSignatureCode,
  isWellFormedSignatureCode,
  signatureCodeExpiry,
  signatureCodeMatches,
} from './signature-code';

const SECRET = 'un-secreto-de-prueba-con-mas-de-32-caracteres!';
const REQUEST = '6f1c1f0e-8a52-4a0e-9b3b-1d2a3c4d5e6f';

describe('código de verificación de 6 dígitos (DX-243)', () => {
  it('genera 6 dígitos (con ceros a la izquierda) y varía', () => {
    const codes = new Set(
      Array.from({ length: 50 }, () => generateSignatureCode()),
    );
    for (const code of codes) expect(code).toMatch(/^\d{6}$/);
    expect(codes.size).toBeGreaterThan(40);
  });

  it('acepta solo 6 dígitos', () => {
    expect(isWellFormedSignatureCode('012345')).toBe(true);
    expect(isWellFormedSignatureCode('12345')).toBe(false);
    expect(isWellFormedSignatureCode('1234567')).toBe(false);
    expect(isWellFormedSignatureCode('12345a')).toBe(false);
    expect(isWellFormedSignatureCode(' 123456')).toBe(false);
  });

  it('solo se guarda un HMAC con clave del servidor, atado a la solicitud', () => {
    const key = deriveSignatureCodeKey(SECRET);
    const hmac = hmacSignatureCode(key, REQUEST, '123456');
    expect(hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(hmac).not.toContain('123456');
    expect(hmacSignatureCode(key, REQUEST, '123456')).toBe(hmac);
    // Otra solicitud u otra clave: otro HMAC (un volcado de la base no basta
    // para probar el millón de códigos).
    expect(
      hmacSignatureCode(key, `${REQUEST.slice(0, -1)}0`, '123456'),
    ).not.toBe(hmac);
    expect(
      hmacSignatureCode(
        deriveSignatureCodeKey(`${SECRET}x`),
        REQUEST,
        '123456',
      ),
    ).not.toBe(hmac);
  });

  it('compara en tiempo constante y rechaza un código distinto o mal formado', () => {
    const key = deriveSignatureCodeKey(SECRET);
    const stored = hmacSignatureCode(key, REQUEST, '654321');
    expect(signatureCodeMatches(key, REQUEST, '654321', stored)).toBe(true);
    expect(signatureCodeMatches(key, REQUEST, '654320', stored)).toBe(false);
    expect(signatureCodeMatches(key, REQUEST, '65432', stored)).toBe(false);
    expect(signatureCodeMatches(key, REQUEST, '654321', 'nohex')).toBe(false);
  });

  it('caduca a los 10 minutos; 5 intentos por enlace; 5 envíos con 60 s entre uno y otro', () => {
    expect(SIGNATURE_CODE_TTL_MINUTES).toBe(10);
    expect(SIGNATURE_CODE_MAX_ATTEMPTS).toBe(5);
    expect(SIGNATURE_CODE_MAX_SENDS).toBe(5);
    expect(SIGNATURE_CODE_RESEND_SECONDS).toBe(60);
    const now = new Date('2026-10-30T12:00:00.000Z');
    expect(signatureCodeExpiry(now).toISOString()).toBe(
      '2026-10-30T12:10:00.000Z',
    );
  });

  it('espera para reenviar: 0 si nunca se envió o ya pasó el minuto', () => {
    const now = new Date('2026-10-30T12:00:30.000Z');
    expect(codeResendWaitSeconds(null, now)).toBe(0);
    expect(
      codeResendWaitSeconds(new Date('2026-10-30T12:00:00.000Z'), now),
    ).toBe(30);
    expect(
      codeResendWaitSeconds(new Date('2026-10-30T11:59:30.000Z'), now),
    ).toBe(0);
    expect(
      codeResendWaitSeconds(new Date('2026-10-30T12:00:29.500Z'), now),
    ).toBe(60);
  });
});
