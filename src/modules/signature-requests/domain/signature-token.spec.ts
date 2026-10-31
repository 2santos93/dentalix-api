import {
  SIGNATURE_LINK_TTL_HOURS,
  SIGNATURE_SESSION_TTL_MINUTES,
  buildSignatureUrl,
  generateSignatureToken,
  hashSignatureToken,
  isWellFormedSignatureToken,
  signatureLinkExpiry,
  signatureSessionExpiry,
} from './signature-token';

describe('token del enlace de firma a distancia (DX-243)', () => {
  it('32 bytes aleatorios en base64url: 43 caracteres, distintos en cada llamada', () => {
    const a = generateSignatureToken();
    const b = generateSignatureToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(b);
    expect(isWellFormedSignatureToken(a)).toBe(true);
  });

  it('solo se guarda el hash: SHA-256 en hex, estable y distinto del token', () => {
    const token = generateSignatureToken();
    const hash = hashSignatureToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashSignatureToken(token));
    expect(hash).not.toContain(token);
    expect(hashSignatureToken(generateSignatureToken())).not.toBe(hash);
  });

  it('descarta lo que no puede ser un token sin consultar la base', () => {
    const token = generateSignatureToken();
    expect(isWellFormedSignatureToken(token.slice(0, 42))).toBe(false);
    expect(isWellFormedSignatureToken(`${token}x`)).toBe(false);
    expect(isWellFormedSignatureToken(`${token.slice(0, 42)}=`)).toBe(false);
    expect(isWellFormedSignatureToken('')).toBe(false);
  });

  it('caduca a las 72 h por defecto', () => {
    const now = new Date('2026-10-30T12:00:00.000Z');
    expect(SIGNATURE_LINK_TTL_HOURS).toBe(72);
    expect(signatureLinkExpiry(now).toISOString()).toBe(
      '2026-11-02T12:00:00.000Z',
    );
  });

  it('la sesión tras verificar dura 30 min y nunca pasa de la caducidad del enlace', () => {
    const now = new Date('2026-10-30T12:00:00.000Z');
    expect(SIGNATURE_SESSION_TTL_MINUTES).toBe(30);
    expect(
      signatureSessionExpiry(now, new Date('2026-11-02T12:00:00.000Z')),
    ).toEqual(new Date('2026-10-30T12:30:00.000Z'));
    const soon = new Date('2026-10-30T12:10:00.000Z');
    expect(signatureSessionExpiry(now, soon)).toEqual(soon);
  });

  it('arma la URL pública /firmar/<token> en el host de la clínica', () => {
    expect(buildSignatureUrl('https', 'demo.dentalix.app', 'abc')).toBe(
      'https://demo.dentalix.app/firmar/abc',
    );
  });
});
