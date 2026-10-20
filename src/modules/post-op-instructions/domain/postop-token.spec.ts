import {
  POSTOP_LINK_TTL_DAYS,
  POSTOP_PUBLIC_PATH,
  buildPostOpUrl,
  generatePostOpToken,
  hashPostOpToken,
  isWellFormedPostOpToken,
  postOpLinkExpiry,
} from './postop-token';

describe('postop-token', () => {
  it('genera un token base64url de 43 caracteres, distinto cada vez', () => {
    const a = generatePostOpToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generatePostOpToken()).not.toBe(a);
  });

  it('el hash es hex de 64 caracteres, estable y distinto del token', () => {
    const token = generatePostOpToken();
    const hash = hashPostOpToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(token);
    expect(hashPostOpToken(token)).toBe(hash);
  });

  it('reconoce la forma válida y descarta el resto', () => {
    expect(isWellFormedPostOpToken(generatePostOpToken())).toBe(true);
    expect(isWellFormedPostOpToken('abc')).toBe(false);
    expect(isWellFormedPostOpToken('')).toBe(false);
    expect(isWellFormedPostOpToken('!'.repeat(43))).toBe(false);
  });

  it('el enlace caduca a los 30 días', () => {
    expect(POSTOP_LINK_TTL_DAYS).toBe(30);
    expect(
      postOpLinkExpiry(new Date('2026-10-20T10:00:00Z')).toISOString(),
    ).toBe('2026-11-19T10:00:00.000Z');
  });

  it('construye la URL pública', () => {
    expect(POSTOP_PUBLIC_PATH).toBe('/indicaciones');
    expect(buildPostOpUrl('https', 'demo.dentalix.app', 'abc')).toBe(
      'https://demo.dentalix.app/indicaciones/abc',
    );
  });
});
