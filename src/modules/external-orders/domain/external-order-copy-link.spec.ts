import {
  EXTERNAL_ORDER_COPY_DEFAULT_TTL_HOURS,
  buildExternalOrderCopyUrl,
  externalOrderCopyExpiresAt,
  externalOrderCopyLinkState,
  externalOrderRecipientMessage,
  externalOrderWhatsAppText,
  loadExternalOrderCopyConfig,
} from './external-order-copy-link';
import { PRESCRIPTION_COPY_NO_EMAIL_MESSAGE } from '../../prescriptions/domain/prescription-copy-recipient';

const NOW = new Date('2026-11-16T12:00:00Z');

describe('enlace de un solo uso de la copia de la orden (DX-572)', () => {
  it('caduca a los 7 días; EXTERNAL_ORDER_COPY_LINK_TTL_HOURS lo ajusta entre 1 y 720', () => {
    expect(loadExternalOrderCopyConfig(() => undefined)).toEqual({
      ttlHours: EXTERNAL_ORDER_COPY_DEFAULT_TTL_HOURS,
    });
    expect(EXTERNAL_ORDER_COPY_DEFAULT_TTL_HOURS).toBe(168);
    expect(loadExternalOrderCopyConfig(() => ' 48 ')).toEqual({ ttlHours: 48 });
    for (const bad of ['0', '721', '1.5', 'siete']) {
      expect(() => loadExternalOrderCopyConfig(() => bad)).toThrow(
        /EXTERNAL_ORDER_COPY_LINK_TTL_HOURS tiene que ser un entero entre 1 y 720/,
      );
    }
    expect(externalOrderCopyExpiresAt(NOW, 168)).toEqual(
      new Date('2026-11-23T12:00:00Z'),
    );
  });

  it('estado: disponible, usado, o 404 genérico si caducó o se invalidó', () => {
    const later = new Date('2026-11-20T12:00:00Z');
    const link = { expiresAt: later, usedAt: null, revokedAt: null };
    expect(externalOrderCopyLinkState(link, NOW)).toBe('AVAILABLE');
    expect(externalOrderCopyLinkState({ ...link, usedAt: NOW }, NOW)).toBe(
      'USED',
    );
    expect(externalOrderCopyLinkState({ ...link, revokedAt: NOW }, NOW)).toBe(
      'GONE',
    );
    expect(externalOrderCopyLinkState(link, later)).toBe('GONE');
  });

  it('la URL de la web es /orden/copia/<token>', () => {
    expect(buildExternalOrderCopyUrl('https://demo.dentalix.app', 'abc')).toBe(
      'https://demo.dentalix.app/orden/copia/abc',
    );
  });

  it('el texto de WhatsApp: clínica, documento y enlace, nada clínico; en el idioma del paciente', () => {
    const es = externalOrderWhatsAppText({
      language: 'es',
      kind: 'SPECIALIST',
      name: 'Luis',
      clinic: 'Clínica Ávila',
      patient: 'Sofía',
      expiresAtLabel: '23/11/2026 8:00 a. m.',
      url: 'https://x/orden/copia/abc',
    });
    expect(es).toBe(
      'Hola Luis, le saludamos de Clínica Ávila. Aquí tiene la referencia al especialista de Sofía (enlace personal de una sola descarga, caduca el 23/11/2026 8:00 a. m.): https://x/orden/copia/abc',
    );
    const en = externalOrderWhatsAppText({
      language: 'en',
      kind: 'IMAGING',
      name: null,
      clinic: 'Clínica Ávila',
      patient: null,
      expiresAtLabel: '23/11/2026',
      url: 'https://x/orden/copia/abc',
    });
    expect(en).toMatch(
      /^Hello, this is Clínica Ávila\. Here is the imaging order/,
    );
  });

  it('los mensajes del destinatario hablan de la orden, no de la receta', () => {
    expect(
      externalOrderRecipientMessage(PRESCRIPTION_COPY_NO_EMAIL_MESSAGE),
    ).toBe(
      'El paciente no tiene email: añádelo en su ficha o envíala por WhatsApp.',
    );
  });
});
