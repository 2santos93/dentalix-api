import { SIGNATURE_LINK_TTL_HOURS } from '../../../../signature-requests/domain/signature-token';
import { renderEmail } from './templates';

const brand = {
  clinicName: 'Sonrisas del Norte',
  logoUrl: null,
  primaryColor: null,
};

// DX-561: el aviso de seguimiento SOLO lleva el nombre de la clínica, el
// saludo, un texto neutro, los enlaces y la baja: ni importes ni tratamientos.
const FORBIDDEN =
  /\b(USD|VES|Bs|implantes?|coronas?|endodoncias?|resinas?|limpiezas?|exodoncias?|tratamientos?|procedimientos?|dientes?|total|importes?|precios?)\b|\$|\d+[.,]\d{2}/i;

describe('plantilla quote-follow-up (DX-561)', () => {
  it('una opción: saludo, texto neutro, botón y baja; nada de importes ni tratamientos', () => {
    const email = renderEmail(
      'quote-follow-up',
      {
        recipientFirstName: 'Ana',
        patientFirstName: null,
        clinicName: 'Sonrisas del Norte',
        expiresInHours: SIGNATURE_LINK_TTL_HOURS,
        urls: ['https://demo.dentalix.app/firmar/abc'],
        unsubscribeUrl: 'https://demo.dentalix.app/baja/xyz',
      },
      brand,
    );
    expect(email.subject).toBe(
      'Tienes un presupuesto pendiente en Sonrisas del Norte',
    );
    expect(email.text).toContain('Hola, Ana');
    expect(email.text).toContain(
      'Tienes un presupuesto pendiente de revisar en Sonrisas del Norte.',
    );
    expect(email.text).toContain(
      'Ver y aceptar el presupuesto: https://demo.dentalix.app/firmar/abc',
    );
    expect(email.html).toContain('href="https://demo.dentalix.app/firmar/abc"');
    expect(email.html).toContain('href="https://demo.dentalix.app/baja/xyz"');
    expect(email.text).toContain('Dejar de recibir avisos');
    expect(email.text).toContain('El enlace caduca en 72 horas.');
    expect(email.html).toContain('El enlace caduca en 72 horas.');
    expect(email.text).not.toMatch(FORBIDDEN);
    expect(email.html.replace(/<[^>]+>/g, ' ')).not.toMatch(FORBIDDEN);
  });

  it('A/B en un solo email: «Opción A» y «Opción B», sin la etiqueta de cada plan', () => {
    const email = renderEmail(
      'quote-follow-up',
      {
        recipientFirstName: 'Luis',
        patientFirstName: 'Sofía',
        clinicName: 'Sonrisas del Norte',
        expiresInHours: SIGNATURE_LINK_TTL_HOURS,
        urls: [
          'https://demo.dentalix.app/firmar/a',
          'https://demo.dentalix.app/firmar/b',
        ],
        unsubscribeUrl: null,
      },
      brand,
    );
    expect(email.text).toContain(
      'Hay un presupuesto de Sofía pendiente de revisar en Sonrisas del Norte.',
    );
    expect(email.subject).toBe(
      'Hay un presupuesto de Sofía pendiente en Sonrisas del Norte',
    );
    expect(email.html).toContain('>Opción A</a>');
    expect(email.html).toContain('>Opción B</a>');
    expect(email.html).toContain('href="https://demo.dentalix.app/firmar/b"');
    expect(email.text).not.toMatch(FORBIDDEN);
  });

  it('en inglés para un paciente con ese idioma (DX-497)', () => {
    const email = renderEmail(
      'quote-follow-up',
      {
        recipientFirstName: 'Ana',
        patientFirstName: null,
        clinicName: 'Sonrisas del Norte',
        expiresInHours: SIGNATURE_LINK_TTL_HOURS,
        urls: ['https://demo.dentalix.app/firmar/abc'],
        unsubscribeUrl: 'https://demo.dentalix.app/baja/xyz',
      },
      brand,
      'en',
    );
    expect(email.subject).toBe(
      'You have a pending quote at Sonrisas del Norte',
    );
    expect(email.text).toContain('View and accept the quote');
    expect(email.text).toContain('Stop receiving notices');
    expect(email.text).toContain('The link expires in 72 hours.');
    expect(email.html).toContain('lang="en"');
  });

  it('de 1 a 3 enlaces', () => {
    const base = {
      recipientFirstName: null,
      patientFirstName: null,
      clinicName: 'X',
      unsubscribeUrl: null,
      expiresInHours: SIGNATURE_LINK_TTL_HOURS,
    };
    expect(() =>
      renderEmail('quote-follow-up', { ...base, urls: [] }, brand),
    ).toThrow();
    expect(() =>
      renderEmail(
        'quote-follow-up',
        {
          ...base,
          expiresInHours: SIGNATURE_LINK_TTL_HOURS,
          urls: ['https://a/1', 'https://a/2', 'https://a/3', 'https://a/4'],
        },
        brand,
      ),
    ).toThrow();
  });
});
