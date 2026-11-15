import { PRESCRIPTION_COPY_OPTED_OUT_MESSAGE } from '../../prescriptions/domain/prescription-copy-recipient';
import {
  CERTIFICATE_COPY_DEFAULT_TTL_DAYS,
  buildCertificateCopyUrl,
  certificateCopyExpiresAt,
  certificateCopyLinkState,
  certificateRecipientMessage,
  certificateWhatsAppText,
  loadCertificateCopyConfig,
} from './certificate-copy-link';

describe('copia del certificado por WhatsApp (DX-306)', () => {
  it('caducidad: 30 días por defecto, 1..90 del entorno, inválido no arranca', () => {
    expect(loadCertificateCopyConfig(() => undefined)).toEqual({
      ttlDays: CERTIFICATE_COPY_DEFAULT_TTL_DAYS,
    });
    expect(loadCertificateCopyConfig(() => '7')).toEqual({ ttlDays: 7 });
    expect(() => loadCertificateCopyConfig(() => '0')).toThrow();
    expect(() => loadCertificateCopyConfig(() => '91')).toThrow();
    expect(() => loadCertificateCopyConfig(() => '2.5')).toThrow();
    const now = new Date('2026-11-16T12:00:00Z');
    expect(certificateCopyExpiresAt(now, 30).toISOString()).toBe(
      '2026-12-16T12:00:00.000Z',
    );
  });

  it('estado del enlace: invalidado, caducado o disponible', () => {
    const now = new Date('2026-11-16T12:00:00Z');
    const future = new Date('2026-11-20T00:00:00Z');
    expect(
      certificateCopyLinkState({ expiresAt: future, revokedAt: now }, now),
    ).toBe('GONE');
    expect(
      certificateCopyLinkState({ expiresAt: now, revokedAt: null }, now),
    ).toBe('EXPIRED');
    expect(
      certificateCopyLinkState({ expiresAt: future, revokedAt: null }, now),
    ).toBe('AVAILABLE');
  });

  it('enlace y texto: clínica, qué documento, caducidad y enlace; nada clínico', () => {
    const url = buildCertificateCopyUrl('https://avila.dentalix.app', 'tok');
    expect(url).toBe('https://avila.dentalix.app/certificado/copia/tok');
    expect(
      certificateWhatsAppText({
        language: 'es',
        kind: 'REST',
        name: 'Mariela',
        clinic: 'Clínica Ávila',
        patient: null,
        expiresAtLabel: '16/12/2026',
        url,
      }),
    ).toBe(
      `Hola Mariela, le saludamos de Clínica Ávila. Aquí tiene el certificado de reposo (enlace personal, caduca el 16/12/2026): ${url}`,
    );
    expect(
      certificateWhatsAppText({
        language: 'en',
        kind: 'ATTENDANCE',
        name: null,
        clinic: 'Ávila',
        patient: 'Sofía',
        expiresAtLabel: '12/16/2026',
        url,
      }),
    ).toBe(
      `Hello, this is Ávila. Here is the attendance certificate for Sofía (personal link, expires on 12/16/2026): ${url}`,
    );
  });

  it('los motivos del destinatario hablan del certificado', () => {
    expect(
      certificateRecipientMessage(PRESCRIPTION_COPY_OPTED_OUT_MESSAGE),
    ).toBe(
      'El paciente dio de baja los envíos: entrégale el certificado impreso.',
    );
    expect(certificateRecipientMessage('otro')).toBe('otro');
  });
});
