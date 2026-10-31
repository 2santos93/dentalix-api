import {
  SIGNED_PDF_COPY_DEFAULT_TTL_HOURS,
  generateSignedPdfCopyToken,
  hashSignedPdfCopyToken,
  isWellFormedSignedPdfCopyToken,
  loadSignedPdfCopyConfig,
  publicSignedPdfCopyState,
  signedPdfCopyExpiresAt,
  buildSignedPdfCopyUrl,
} from './signed-pdf-copy-link';

const NOW = new Date('2026-10-31T12:00:00.000Z');

describe('enlace de la copia del PDF firmado (DX-443)', () => {
  it('genera tokens de 256 bits en base64url, distintos cada vez', () => {
    const a = generateSignedPdfCopyToken();
    const b = generateSignedPdfCopyToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(isWellFormedSignedPdfCopyToken(a)).toBe(true);
  });

  it('guarda solo el sha256 en hex (nunca el token)', () => {
    const token = generateSignedPdfCopyToken();
    const hash = hashSignedPdfCopyToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashSignedPdfCopyToken(token)).toBe(hash);
  });

  it('descarta en el acto lo que no puede ser un token', () => {
    expect(isWellFormedSignedPdfCopyToken('')).toBe(false);
    expect(isWellFormedSignedPdfCopyToken('abc')).toBe(false);
    expect(isWellFormedSignedPdfCopyToken(`${'a'.repeat(42)}!`)).toBe(false);
    expect(isWellFormedSignedPdfCopyToken('a'.repeat(44))).toBe(false);
  });

  it('la caducidad es configurable en horas (7 días por defecto)', () => {
    expect(loadSignedPdfCopyConfig(() => undefined)).toEqual({
      ttlHours: SIGNED_PDF_COPY_DEFAULT_TTL_HOURS,
    });
    expect(SIGNED_PDF_COPY_DEFAULT_TTL_HOURS).toBe(168);
    expect(
      loadSignedPdfCopyConfig((k) =>
        k === 'SIGNED_PDF_COPY_LINK_TTL_HOURS' ? '48' : undefined,
      ),
    ).toEqual({ ttlHours: 48 });
    for (const bad of ['0', '-1', '1.5', 'x', '721']) {
      expect(() =>
        loadSignedPdfCopyConfig((k) =>
          k === 'SIGNED_PDF_COPY_LINK_TTL_HOURS' ? bad : undefined,
        ),
      ).toThrow(/SIGNED_PDF_COPY_LINK_TTL_HOURS/);
    }
    expect(signedPdfCopyExpiresAt(NOW, 48).toISOString()).toBe(
      '2026-11-02T12:00:00.000Z',
    );
  });

  it('arma la URL pública de la web', () => {
    expect(buildSignedPdfCopyUrl('https://demo.dentalix.app', 'tok')).toBe(
      'https://demo.dentalix.app/copia/tok',
    );
  });

  describe('estado público', () => {
    const live = {
      expiresAt: new Date(NOW.getTime() + 60_000),
      usedAt: null,
      revokedAt: null,
    };

    it('vivo y sin usar: disponible', () => {
      expect(publicSignedPdfCopyState(live, NOW)).toBe('AVAILABLE');
    });

    it('ya usado: «enlace usado»', () => {
      expect(publicSignedPdfCopyState({ ...live, usedAt: NOW }, NOW)).toBe(
        'USED',
      );
    });

    it('caducado o invalidado al reenviar: 404 genérico', () => {
      expect(publicSignedPdfCopyState({ ...live, expiresAt: NOW }, NOW)).toBe(
        'GONE',
      );
      expect(publicSignedPdfCopyState({ ...live, revokedAt: NOW }, NOW)).toBe(
        'GONE',
      );
    });

    it('usado y ya caducado: también 404 genérico', () => {
      expect(
        publicSignedPdfCopyState({ ...live, usedAt: NOW, expiresAt: NOW }, NOW),
      ).toBe('GONE');
    });
  });
});
