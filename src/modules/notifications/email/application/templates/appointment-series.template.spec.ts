import { renderEmail } from './templates';
import type { AppointmentSeriesEmailVars } from '../../domain/email-message';

const brand = {
  clinicName: 'Sonrisas del Norte',
  logoUrl: null,
  primaryColor: null,
};

// DX-562: el aviso de la serie lleva la clínica, la sede, el profesional y
// las fechas: ni motivo, ni notas, ni tratamientos, ni importes.
const FORBIDDEN =
  /\b(USD|VES|Bs|implantes?|coronas?|endodoncias?|ortodoncia|tratamientos?|procedimientos?|motivo|notas?|importes?|precios?)\b|\$/i;

const vars = (
  overrides: Partial<AppointmentSeriesEmailVars> = {},
): AppointmentSeriesEmailVars => ({
  recipientFirstName: 'Ana',
  patientFirstName: null,
  clinicName: 'Sonrisas del Norte',
  locationName: 'Sede Chacao',
  providerName: 'Dra. Rosa Pérez',
  dateLabels: [
    'lunes 18 de enero de 2027 a las 9:00 a. m.',
    'lunes 15 de febrero de 2027 a las 9:00 a. m.',
    'lunes 15 de marzo de 2027 a las 9:00 a. m.',
  ],
  unsubscribeUrl: null,
  ...overrides,
});

describe('plantilla appointment-series (DX-562)', () => {
  it('al paciente: saludo, cuántas citas, dónde y con quién, y las fechas numeradas', () => {
    const email = renderEmail('appointment-series', vars(), brand);
    expect(email.subject).toBe('Tus próximas citas en Sonrisas del Norte');
    expect(email.text).toContain('Hola, Ana');
    expect(email.text).toContain(
      'Te agendamos 3 citas en Sede Chacao con Dra. Rosa Pérez.',
    );
    expect(email.text).toContain('Fechas y horas:');
    expect(email.text).toContain(
      '1. lunes 18 de enero de 2027 a las 9:00 a. m.',
    );
    expect(email.text).toContain(
      '3. lunes 15 de marzo de 2027 a las 9:00 a. m.',
    );
    expect(email.html).toContain('lunes 15 de febrero de 2027');
    expect(email.html).toContain('<html lang="es">');
    expect(`${email.subject}\n${email.text}`).not.toMatch(FORBIDDEN);
  });

  it('al responsable de un menor: lo saluda a él y dice de quién son las citas', () => {
    const email = renderEmail(
      'appointment-series',
      vars({ recipientFirstName: 'Carlos', patientFirstName: 'Sofía' }),
      brand,
    );
    expect(email.subject).toBe(
      'Las próximas citas de Sofía en Sonrisas del Norte',
    );
    expect(email.text).toContain('Hola, Carlos');
    expect(email.text).toContain(
      'Agendamos 3 citas de Sofía en Sede Chacao con Dra. Rosa Pérez.',
    );
  });

  it('sin profesional ni nombre: sin «con» ni nombre en el saludo', () => {
    const email = renderEmail(
      'appointment-series',
      vars({ recipientFirstName: null, providerName: null }),
      brand,
    );
    expect(email.text).toContain('Hola');
    expect(email.text).toContain('Te agendamos 3 citas en Sede Chacao.');
  });

  it('en inglés (DX-497): los textos del catálogo; las fechas, las de la sede', () => {
    const email = renderEmail('appointment-series', vars(), brand, 'en');
    expect(email.subject).toBe(
      'Your upcoming appointments at Sonrisas del Norte',
    );
    expect(email.text).toContain(
      'We booked 3 appointments for you at Sede Chacao with Dra. Rosa Pérez.',
    );
    expect(email.text).toContain('Dates and times:');
    expect(email.text).toContain('lunes 18 de enero de 2027');
    expect(email.html).toContain('<html lang="en">');
  });

  it('escapa lo variable (sin HTML injection)', () => {
    const email = renderEmail(
      'appointment-series',
      vars({ locationName: '<b>Sede</b>', dateLabels: ['<i>x</i>', 'y'] }),
      brand,
    );
    expect(email.html).not.toContain('<b>Sede</b>');
    expect(email.html).toContain('&lt;b&gt;Sede&lt;/b&gt;');
    expect(email.html).not.toContain('<i>x</i>');
  });

  it('DX-128: con enlace de baja, al pie (HTML y texto); sin él, no sale', () => {
    const email = renderEmail(
      'appointment-series',
      vars({ unsubscribeUrl: 'https://demo.dentalix.app/baja/xyz' }),
      brand,
    );
    expect(email.html).toContain('href="https://demo.dentalix.app/baja/xyz"');
    expect(email.text).toContain('Dejar de recibir avisos');
    expect(email.text).toContain('https://demo.dentalix.app/baja/xyz');
    const without = renderEmail('appointment-series', vars(), brand);
    expect(without.text).not.toContain('Dejar de recibir avisos');
  });

  it('de 2 a 26 fechas', () => {
    expect(() =>
      renderEmail('appointment-series', vars({ dateLabels: ['solo'] }), brand),
    ).toThrow('de 2 a 26 fechas');
    expect(() =>
      renderEmail(
        'appointment-series',
        vars({ dateLabels: Array.from({ length: 27 }, (_, i) => `${i}`) }),
        brand,
      ),
    ).toThrow('de 2 a 26 fechas');
  });
});
