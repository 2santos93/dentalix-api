import {
  ANAMNESIS_LINK_TTL_DAYS,
  anamnesisLinkExpiry,
  buildAnamnesisUrl,
  generateAnamnesisToken,
  hashAnamnesisToken,
  isWellFormedAnamnesisToken,
} from './anamnesis-token';

describe('token del enlace de anamnesis (DX-099)', () => {
  it('32 bytes aleatorios en base64url: 43 caracteres, distintos en cada llamada', () => {
    const a = generateAnamnesisToken();
    const b = generateAnamnesisToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(b);
    expect(isWellFormedAnamnesisToken(a)).toBe(true);
  });

  it('el hash es SHA-256 en hex, estable y distinto del token', () => {
    const token = generateAnamnesisToken();
    const hash = hashAnamnesisToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashAnamnesisToken(token));
    expect(hash).not.toContain(token);
    expect(hashAnamnesisToken(generateAnamnesisToken())).not.toBe(hash);
  });

  it('descarta lo que no puede ser un token (truncado, con caracteres raros)', () => {
    const token = generateAnamnesisToken();
    expect(isWellFormedAnamnesisToken(token.slice(0, 42))).toBe(false);
    expect(isWellFormedAnamnesisToken(`${token}x`)).toBe(false);
    expect(isWellFormedAnamnesisToken(`${token.slice(0, 42)}=`)).toBe(false);
    expect(isWellFormedAnamnesisToken('')).toBe(false);
  });

  describe('caducidad', () => {
    const now = new Date('2026-10-23T15:00:00.000Z');

    it('sin cita: 7 días', () => {
      expect(ANAMNESIS_LINK_TTL_DAYS).toBe(7);
      expect(anamnesisLinkExpiry(now, null).toISOString()).toBe(
        '2026-10-30T15:00:00.000Z',
      );
    });

    it('con la cita antes de 7 días: caduca al inicio de la cita', () => {
      const start = new Date('2026-10-25T13:30:00.000Z');
      expect(anamnesisLinkExpiry(now, start)).toEqual(start);
    });

    it('con la cita después de 7 días: 7 días', () => {
      const start = new Date('2026-11-20T13:30:00.000Z');
      expect(anamnesisLinkExpiry(now, start).toISOString()).toBe(
        '2026-10-30T15:00:00.000Z',
      );
    });
  });

  it('la URL pública vive en /anamnesis/<token> del host de la clínica', () => {
    expect(buildAnamnesisUrl('https', 'demo.dentalix.app', 'abc')).toBe(
      'https://demo.dentalix.app/anamnesis/abc',
    );
  });
});
