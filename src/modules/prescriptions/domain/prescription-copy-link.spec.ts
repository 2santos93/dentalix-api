import {
  DEFAULT_PRESCRIPTION_COPY_FOOTER,
  PRESCRIPTION_COPY_DEFAULT_TTL_DAYS,
  buildPrescriptionCopyUrl,
  loadPrescriptionCopyConfig,
  maskPhoneDigits,
  prescriptionCopyExpiresAt,
  prescriptionCopyFooter,
  prescriptionCopyLinkState,
} from './prescription-copy-link';
import {
  generatePublicLinkToken,
  hashPublicLinkToken,
  isWellFormedPublicLinkToken,
} from '../../../shared/public-links/public-link-token';

describe('copia de la receta para el paciente (DX-468)', () => {
  const NOW = new Date('2026-11-15T12:00:00.000Z');

  it('caduca a los 30 días por defecto y se puede ajustar por entorno (1..90)', () => {
    expect(PRESCRIPTION_COPY_DEFAULT_TTL_DAYS).toBe(30);
    expect(loadPrescriptionCopyConfig(() => undefined)).toEqual({
      ttlDays: 30,
    });
    expect(loadPrescriptionCopyConfig(() => ' 7 ')).toEqual({ ttlDays: 7 });
    for (const bad of ['0', '91', '1.5', 'x', '-3']) {
      expect(() => loadPrescriptionCopyConfig(() => bad)).toThrow(
        /PRESCRIPTION_COPY_LINK_TTL_DAYS/,
      );
    }
    expect(prescriptionCopyExpiresAt(NOW, 30).toISOString()).toBe(
      '2026-12-15T12:00:00.000Z',
    );
  });

  it('el token es el de los enlaces públicos: 43 caracteres URL-safe y solo su hash en la BD', () => {
    const token = generatePublicLinkToken();
    expect(isWellFormedPublicLinkToken(token)).toBe(true);
    expect(isWellFormedPublicLinkToken(`${token}x`)).toBe(false);
    expect(isWellFormedPublicLinkToken('ABC123')).toBe(false);
    expect(hashPublicLinkToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPublicLinkToken(token)).not.toContain(token);
    expect(generatePublicLinkToken()).not.toBe(token);
  });

  it('la URL va a /receta/copia/<token> del host de la clínica', () => {
    expect(buildPrescriptionCopyUrl('https://demo.dentalix.app', 'tok')).toBe(
      'https://demo.dentalix.app/receta/copia/tok',
    );
  });

  it('estado: invalidado = GONE (404); caducado = EXPIRED (410); si no, AVAILABLE', () => {
    const live = {
      expiresAt: new Date('2026-11-16T00:00:00Z'),
      revokedAt: null,
    };
    expect(prescriptionCopyLinkState(live, NOW)).toBe('AVAILABLE');
    expect(prescriptionCopyLinkState({ ...live, expiresAt: NOW }, NOW)).toBe(
      'EXPIRED',
    );
    expect(
      prescriptionCopyLinkState(
        { expiresAt: new Date('2026-11-01T00:00:00Z'), revokedAt: NOW },
        NOW,
      ),
    ).toBe('GONE');
  });

  it('el pie: el de la clínica o, vacío, el de plataforma', () => {
    expect(prescriptionCopyFooter(null)).toBe(DEFAULT_PRESCRIPTION_COPY_FOOTER);
    expect(prescriptionCopyFooter('   ')).toBe(
      DEFAULT_PRESCRIPTION_COPY_FOOTER,
    );
    expect(prescriptionCopyFooter('  Solo informativa.  ')).toBe(
      'Solo informativa.',
    );
    expect(DEFAULT_PRESCRIPTION_COPY_FOOTER).toContain(
      'Copia para el paciente. Para retirar el medicamento presente la receta impresa y firmada',
    );
  });

  it('el teléfono enmascarado deja solo los 4 últimos dígitos', () => {
    expect(maskPhoneDigits('584121234567')).toBe('••• 4567');
  });
});
