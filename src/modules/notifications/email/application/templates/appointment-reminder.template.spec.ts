import { EMAIL_LOCALES, type EmailBrand } from '../../domain/email-message';
import { renderEmail } from './templates';

const brand: EmailBrand = {
  clinicName: 'Sonrisas del Norte',
  logoUrl: null,
  primaryColor: null,
};

const vars = {
  patientName: 'Carolina',
  // DX-315: la fecha llega ya escrita con el locale y la zona de la SEDE.
  startsAtLabel: 'martes 20 de octubre de 2026 a las 9:30 a. m.',
  locationName: 'Sede Norte',
  locationAddress: 'Av. Francisco de Miranda 93',
  providerName: 'Dra. Laura Gómez',
  confirmUrl: 'https://demo.dentalix.app/confirmar/abc',
  unsubscribeUrl: 'https://demo.dentalix.app/baja/xyz',
  calendar: {
    icsUrl: 'https://demo.dentalix.app/api/v1/public/x/calendar.ics',
    start: '2026-10-20T13:30:00.000Z',
    end: '2026-10-20T14:00:00.000Z',
  },
  cancellationPolicy: { noticeHours: 24, text: '', feeLabel: 'USD 20.00' },
};

describe('appointment-reminder por idioma (DX-497)', () => {
  it('en: asunto y cuerpo en inglés; la fecha y la hora, las de la sede', () => {
    const email = renderEmail('appointment-reminder', vars, brand, 'en');
    expect(email.subject).toBe(
      'Reminder: your appointment at Sonrisas del Norte',
    );
    expect(email.text).toContain('Hello Carolina,');
    expect(email.text).toContain(
      'Date and time: martes 20 de octubre de 2026 a las 9:30 a. m. (local time at the clinic)',
    );
    expect(email.text).toContain('Provider: Dra. Laura Gómez');
    expect(email.text).toContain('Confirm or cancel: https://');
    expect(email.text).toContain('Stop receiving reminders');
    expect(email.text).toContain('Sent by Sonrisas del Norte via Dentalix.');
    expect(email.text).toContain('may incur a fee of USD 20.00.');
    expect(email.html).toContain('<html lang="en">');
    expect(email.html).toContain('If the button does not work');
    // Google Calendar: título en inglés.
    expect(email.html).toContain('Appointment+at+Sonrisas+del+Norte');
    // Nada en español fuera de lo que escribió la clínica o la sede.
    for (const es of ['Hola', 'Recordatorio', 'Enviado por', 'Profesional:']) {
      expect(email.text).not.toContain(es);
    }
  });

  it('en, de un menor: saluda al tutor y nombra al paciente', () => {
    const email = renderEmail(
      'appointment-reminder',
      { ...vars, guardianName: 'María' },
      brand,
      'en',
    );
    expect(email.subject).toBe(
      'Reminder: Carolina’s appointment at Sonrisas del Norte',
    );
    expect(email.text).toContain('Hello María,');
  });

  it('es sigue igual que antes de DX-497', () => {
    const email = renderEmail('appointment-reminder', vars, brand, 'es');
    expect(email.subject).toBe('Recordatorio de tu cita en Sonrisas del Norte');
    expect(email.html).toContain('<html lang="es">');
    expect(email.text).toContain(
      'Enviado por Sonrisas del Norte a través de Dentalix.',
    );
  });

  it('cada idioma del catálogo produce un email', () => {
    for (const locale of EMAIL_LOCALES) {
      expect(
        renderEmail('appointment-reminder', vars, brand, locale).subject,
      ).toContain('Sonrisas del Norte');
    }
  });

  it('una plantilla sin catálogo por idioma no acepta otro idioma', () => {
    expect(() =>
      renderEmail(
        'password-reset',
        { userName: 'Luis', resetUrl: 'https://a.co/x', expiresInMinutes: 30 },
        brand,
        'en',
      ),
    ).toThrow('Idioma de email no soportado');
  });
});
