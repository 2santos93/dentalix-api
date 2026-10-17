import { EmailBrand } from '../../domain/email-message';
import { escapeHtml, safeUrl, singleLine } from './escape';
import { renderEmail } from './templates';

const brand: EmailBrand = {
  clinicName: 'Sonrisas del Norte',
  logoUrl: 'https://cdn.dentalix.app/logos/sonrisas.png',
  primaryColor: '#123ABC',
};

const ACCEPT_URL =
  'https://sonrisas.dentalix.app/invitacion/0123456789abcdef0123456789abcdef';

describe('escape', () => {
  it('escapeHtml neutraliza marcado y comillas', () => {
    expect(escapeHtml(`<b onclick="x">'&'</b>`)).toBe(
      '&lt;b onclick=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/b&gt;',
    );
  });

  it('safeUrl solo deja pasar http(s) absolutas', () => {
    expect(safeUrl('https://a.co/x')).toBe('https://a.co/x');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,hi')).toBeNull();
    expect(safeUrl('/relativa.png')).toBeNull();
    expect(safeUrl(null)).toBeNull();
  });

  it('singleLine quita saltos y controles (asunto sin inyección de cabeceras)', () => {
    expect(singleLine('Hola\r\nBcc: x@y.co\t ')).toBe('Hola Bcc: x@y.co');
    expect(singleLine('A\u2028B\u2029C\u0085D\u009bE\u007f')).toBe('A B C D E');
  });
});

describe('plantilla invitation', () => {
  const vars = {
    inviteeName: 'Ana Pérez',
    roleLabel: 'Odontólogo/a',
    acceptUrl: ACCEPT_URL,
    expiresInDays: 7,
  };

  it('en español, con la marca de la clínica, el enlace y la caducidad', () => {
    const email = renderEmail('invitation', vars, brand);
    expect(email.subject).toBe('Te invitaron a unirte a Sonrisas del Norte');
    expect(email.html).toContain('lang="es"');
    expect(email.html).toContain(`href="${ACCEPT_URL}"`);
    expect(email.html).toContain(
      'src="https://cdn.dentalix.app/logos/sonrisas.png"',
    );
    expect(email.html).toContain('background:#123ABC');
    expect(email.html).toContain('Aceptar invitación');
    expect(email.text).toContain(`Aceptar invitación: ${ACCEPT_URL}`);
    expect(email.text).toContain('caduca en 7 días');
    expect(email.text).toContain('Hola, Ana Pérez');
    expect(email.text).toContain('rol de Odontólogo/a');
  });

  it('escapa el nombre de la clínica y del invitado (sin HTML injection)', () => {
    const evil: EmailBrand = {
      clinicName: '<script>alert(1)</script>Clínica',
      logoUrl: null,
      primaryColor: 'red;background:url(javascript:alert(1))',
    };
    const email = renderEmail(
      'invitation',
      { ...vars, inviteeName: '<img src=x onerror=alert(1)>' },
      evil,
    );
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<img src=x');
    expect(email.html).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt;Clínica',
    );
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // Un color que no es #RRGGBB no entra al estilo: se usa el de Dentalix.
    expect(email.html).not.toContain('javascript:');
    expect(email.html).toContain('#0F5E9C');
  });

  it('sin logo usable firma con el nombre; sin tenant firma Dentalix', () => {
    const noLogo = renderEmail('invitation', vars, {
      ...brand,
      logoUrl: 'javascript:alert(1)',
    });
    expect(noLogo.html).not.toContain('<img');
    expect(noLogo.html).toContain('>Sonrisas del Norte</span>');

    const platform = renderEmail('invitation', vars, null);
    expect(platform.subject).toBe('Te invitaron a unirte a Dentalix');
    expect(platform.text).toContain('Enviado por Dentalix.');
  });

  it('se niega a pintar un enlace que no sea http(s)', () => {
    expect(() =>
      renderEmail(
        'invitation',
        { ...vars, acceptUrl: 'javascript:alert(1)' },
        brand,
      ),
    ).toThrow('URL http(s)');
  });

  it('un salto de línea en el nombre de la clínica no rompe el asunto', () => {
    const email = renderEmail('invitation', vars, {
      ...brand,
      clinicName: 'Clínica\r\nBcc: x@evil.co',
    });
    expect(email.subject).toBe(
      'Te invitaron a unirte a Clínica Bcc: x@evil.co',
    );
  });
});

describe('plantillas reservadas para otras tareas', () => {
  it('password-reset', () => {
    const email = renderEmail(
      'password-reset',
      {
        userName: 'Luis',
        resetUrl: 'https://demo.dentalix.app/restablecer/abc',
        expiresInMinutes: 30,
      },
      brand,
    );
    expect(email.subject).toBe('Restablece tu contraseña');
    expect(email.html).toContain(
      'href="https://demo.dentalix.app/restablecer/abc"',
    );
    expect(email.text).toContain('caduca en 30 minutos');
  });

  it('email-verify', () => {
    const email = renderEmail(
      'email-verify',
      {
        verifyUrl: 'https://demo.dentalix.app/verificar/abc',
        expiresInHours: 1,
      },
      null,
    );
    expect(email.subject).toBe('Confirma tu correo electrónico');
    // DX-144 (SEC-034): saludo genérico, sin el nombre que escribió quien
    // pidió el alta (cualquiera puede pedirla con un email ajeno).
    expect(email.html).toContain('Hola:');
    expect(email.text).toContain('\nHola:\n');
    expect(email.text).toContain('caduca en 1 hora.');
    // DX-029 (R2): quien no pidió el alta sabe que no debe confirmarla.
    expect(email.text).toContain(
      'Si no has pedido crear una clínica en Dentalix, ignora este correo',
    );
    expect(email.text).toContain('la contraseña que elegiste');
  });

  it('appointment-reminder con y sin enlace de confirmación', () => {
    const base = {
      patientName: 'Carolina',
      startsAtLabel: 'martes 20 de octubre de 2026 a las 9:30 a. m.',
      locationName: 'Sede Norte',
      locationAddress: 'Cra 15 # 93-60',
      providerName: 'Dra. Laura Gómez',
      confirmUrl: 'https://demo.dentalix.app/confirmar/abc',
    };
    const withLink = renderEmail('appointment-reminder', base, brand);
    expect(withLink.subject).toBe(
      'Recordatorio de tu cita en Sonrisas del Norte',
    );
    expect(withLink.text).toContain('Hola, Carolina');
    expect(withLink.text).toContain(
      'Te recordamos tu cita en Sonrisas del Norte.',
    );
    expect(withLink.text).toContain(
      'Fecha y hora: martes 20 de octubre de 2026 a las 9:30 a. m. (hora de la sede)',
    );
    expect(withLink.text).toContain('Sede: Sede Norte (Cra 15 # 93-60)');
    expect(withLink.text).toContain('Profesional: Dra. Laura Gómez');
    expect(withLink.html).toContain('Confirmar o cancelar');
    expect(withLink.html).toContain(
      'href="https://demo.dentalix.app/confirmar/abc"',
    );

    const noLink = renderEmail(
      'appointment-reminder',
      { ...base, confirmUrl: null, locationAddress: null, providerName: null },
      brand,
    );
    expect(noLink.html).not.toContain('<a href');
    expect(noLink.text).toContain('Sede: Sede Norte');
    expect(noLink.text).not.toContain('Profesional');
  });

  it('appointment-reminder escapa lo variable y no lleva nada clínico', () => {
    const email = renderEmail(
      'appointment-reminder',
      {
        patientName: '<b>Ana</b>',
        startsAtLabel: 'martes 20 de octubre de 2026 a las 9:30 a. m.',
        locationName: 'Sede <script>',
        locationAddress: null,
        providerName: 'Dr. "X"',
        confirmUrl: 'https://demo.dentalix.app/confirmar/abc',
      },
      brand,
    );
    expect(email.html).not.toContain('<b>Ana</b>');
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
    // Las variables de la plantilla no admiten motivo, notas ni tratamiento:
    // el texto solo nombra fecha, sede, profesional y el enlace.
    expect(email.text).not.toMatch(/motivo|tratamiento|diagn/i);
  });

  describe('payment-receipt (DX-136)', () => {
    const base = {
      patientName: 'Carolina Duque',
      reference: 'NOR-000123',
      legacy: false,
      locationName: 'Sede Norte',
      locationAddress: 'Cra 15 # 93-60',
      fiscalLine: null,
      patientDocLabel: 'CC ******5678',
      amountLabel: '$ 150.000',
      paidOnLabel: '17/10/2026',
      methodLabel: 'Efectivo',
      planLabel: 'Plan del 01/09/2026 · Opción A: implante',
      balanceLabel: '$ 450.000',
      cashierName: 'Recepción Demo',
      voided: null,
      legalNotice: 'Este documento no es factura',
    };

    it('lleva el número, el importe, el documento enmascarado, el aviso fiscal y el pie legal', () => {
      const email = renderEmail('payment-receipt', base, brand);
      expect(email.subject).toBe(
        'Recibo de caja NOR-000123 · Sonrisas del Norte',
      );
      expect(email.text).toContain('Hola, Carolina Duque');
      expect(email.text).toContain('Recibo de caja N.º NOR-000123');
      expect(email.text).toContain('Documento: CC ******5678');
      expect(email.text).toContain('Valor: $ 150.000 · Efectivo · 17/10/2026');
      expect(email.text).toContain('Saldo del plan tras el abono: $ 450.000');
      expect(email.text).toContain('Sede: Sede Norte (Cra 15 # 93-60)');
      expect(email.text).toContain('Datos fiscales pendientes');
      expect(email.text).toContain('Este documento no es factura');
      expect(email.html).not.toContain('<a href');
    });

    it('un recibo anulado lo dice en el asunto y en el cuerpo, con fecha y motivo', () => {
      const email = renderEmail(
        'payment-receipt',
        {
          ...base,
          voided: { dateLabel: '18/10/2026', reason: 'Cobro duplicado' },
        },
        brand,
      );
      expect(email.subject).toBe(
        'Recibo de caja NOR-000123 (ANULADO) · Sonrisas del Norte',
      );
      expect(email.text).toContain(
        'ANULADO el 18/10/2026. Motivo: Cobro duplicado',
      );
    });

    it('uno sin serie lo indica; con datos fiscales los muestra; escapa lo variable', () => {
      const email = renderEmail(
        'payment-receipt',
        {
          ...base,
          reference: 'REC-3f1c2b9e',
          legacy: true,
          fiscalLine: 'Sonrisas S.A.S. · NIT 900123456-7',
          patientName: '<b>Ana</b>',
          patientDocLabel: null,
          balanceLabel: null,
        },
        brand,
      );
      expect(email.text).toContain('sin serie');
      expect(email.text).toContain('Sonrisas S.A.S. · NIT 900123456-7');
      expect(email.text).not.toContain('Datos fiscales pendientes');
      expect(email.text).not.toContain('Documento:');
      expect(email.text).not.toContain('Saldo del plan');
      expect(email.html).not.toContain('<b>Ana</b>');
    });
  });

  it('rechaza un idioma sin plantilla', () => {
    expect(() =>
      renderEmail(
        'email-verify',
        { verifyUrl: 'https://a.co', expiresInHours: 1 },
        null,
        'en' as 'es',
      ),
    ).toThrow('Idioma de email no soportado');
  });
});
