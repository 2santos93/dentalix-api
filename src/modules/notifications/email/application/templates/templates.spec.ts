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
        userName: 'Luis <b>',
        verifyUrl: 'https://demo.dentalix.app/verificar/abc',
        expiresInHours: 1,
      },
      null,
    );
    expect(email.subject).toBe('Confirma tu correo electrónico');
    expect(email.html).toContain('Hola, Luis &lt;b&gt;');
    expect(email.text).toContain('caduca en 1 hora.');
  });

  it('appointment-reminder con y sin enlace de confirmación', () => {
    const base = {
      patientName: 'Carolina Duque',
      startsAtLabel: 'lunes 20 de octubre, 9:30 a. m.',
      locationName: 'Sede Norte',
      locationAddress: 'Cra 15 # 93-60',
      confirmUrl: 'https://demo.dentalix.app/confirmar/abc',
    };
    const withLink = renderEmail('appointment-reminder', base, brand);
    expect(withLink.subject).toBe(
      'Recordatorio de tu cita en Sonrisas del Norte',
    );
    expect(withLink.text).toContain(
      'Te recordamos tu cita el lunes 20 de octubre, 9:30 a. m. en Sede Norte (Cra 15 # 93-60).',
    );
    expect(withLink.html).toContain('Confirmar o cancelar');

    const noLink = renderEmail(
      'appointment-reminder',
      { ...base, confirmUrl: null, locationAddress: null },
      brand,
    );
    expect(noLink.html).not.toContain('<a href');
    expect(noLink.text).toContain('en Sede Norte.');
  });

  it('rechaza un idioma sin plantilla', () => {
    expect(() =>
      renderEmail(
        'email-verify',
        { userName: 'x', verifyUrl: 'https://a.co', expiresInHours: 1 },
        null,
        'en' as 'es',
      ),
    ).toThrow('Idioma de email no soportado');
  });
});
