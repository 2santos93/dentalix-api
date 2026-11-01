import { EmailBrand } from '../../domain/email-message';
import { escapeHtml, safeUrl, singleLine } from './escape';
import { renderEmail } from './templates';
import { regionalFormat } from '../../../../../shared/format/regional-format';

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
      unsubscribeUrl: null,
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
    expect(noLink.html).not.toContain('<a ');
    expect(noLink.text).toContain('Sede: Sede Norte');
    expect(noLink.text).not.toContain('Profesional');
  });

  it('appointment-reminder lleva la política de cancelación de la sede (DX-291, {politica_cancelacion})', () => {
    const base = {
      patientName: 'Carolina',
      startsAtLabel: 'martes 20 de octubre de 2026 a las 9:30 a. m.',
      locationName: 'Sede Norte',
      locationAddress: null,
      providerName: null,
      confirmUrl: null,
      unsubscribeUrl: null,
    };
    const withPolicy = renderEmail(
      'appointment-reminder',
      {
        ...base,
        cancellationPolicy: {
          noticeHours: 24,
          text: 'Las citas no avisadas se cobran.',
          feeLabel: '$ 50.000 COP',
        },
      },
      brand,
    );
    const expected =
      'Política de cancelación: si no puedes asistir, avísanos con al menos 24 h de antelación. Las citas no avisadas se cobran. La inasistencia o la cancelación con menos aviso puede tener un cargo de $ 50.000 COP.';
    expect(withPolicy.text).toContain(expected);
    expect(withPolicy.html).toContain('Política de cancelación');

    const htmlInjection = renderEmail(
      'appointment-reminder',
      {
        ...base,
        cancellationPolicy: {
          noticeHours: 2,
          text: '<script>alert(1)</script>',
          feeLabel: null,
        },
      },
      brand,
    );
    expect(htmlInjection.html).not.toContain('<script>');
    expect(htmlInjection.text).not.toContain('cargo de');

    const without = renderEmail('appointment-reminder', base, brand);
    expect(without.text).not.toContain('Política de cancelación');
  });

  it('policy fee whose currency symbol ends in a period is not followed by a second one (G1-B)', () => {
    const feeLabel = regionalFormat({
      locale: 'ar-EG',
      hourCycle: 'h12',
    }).money(50, 'EGP');
    expect(feeLabel.endsWith('.')).toBe(true);
    const email = renderEmail(
      'appointment-reminder',
      {
        patientName: 'Carolina',
        startsAtLabel: 'martes 20 de octubre de 2026 a las 9:30 a. m.',
        locationName: 'Sede Norte',
        locationAddress: null,
        providerName: null,
        confirmUrl: null,
        unsubscribeUrl: null,
        cancellationPolicy: { noticeHours: 24, text: '', feeLabel },
      },
      brand,
    );
    // El texto plano normaliza los espacios: se compara con `\s`.
    expect(email.text).toMatch(/puede tener un cargo de 50\.00\sج\.م\.(?!\.)/);
  });

  it('appointment-reminder de un menor saluda a su tutor y nombra al paciente (DX-128)', () => {
    const email = renderEmail(
      'appointment-reminder',
      {
        patientName: 'Mateo',
        guardianName: 'María',
        startsAtLabel: 'martes 20 de octubre de 2026 a las 9:30 a. m.',
        locationName: 'Sede Norte',
        locationAddress: null,
        providerName: null,
        confirmUrl: null,
        unsubscribeUrl: null,
      },
      brand,
    );
    expect(email.subject).toBe(
      'Recordatorio de la cita de Mateo en Sonrisas del Norte',
    );
    expect(email.text).toContain('Hola, María');
    expect(email.text).toContain(
      'Te recordamos la cita de Mateo en Sonrisas del Norte.',
    );
    expect(email.text).not.toContain('tu cita');
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
        unsubscribeUrl: null,
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
      patientDocLabel: 'Documento nacional ******5678',
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
      expect(email.text).toContain('Documento: Documento nacional ******5678');
      expect(email.text).toContain('Valor: $ 150.000 · Efectivo · 17/10/2026');
      expect(email.text).toContain('Saldo del plan tras el abono: $ 450.000');
      expect(email.text).toContain('Sede: Sede Norte (Cra 15 # 93-60)');
      expect(email.text).toContain('Datos fiscales pendientes');
      expect(email.text).toContain('Este documento no es factura');
      expect(email.html).not.toContain('<a href');
    });

    it('DX-262 (revisión N1): un abono al saldo migrado no habla de «plan»', () => {
      const email = renderEmail(
        'payment-receipt',
        {
          ...base,
          planLabel: 'Saldo migrado · Ortodoncia · corte 15/03/2026',
          toOpeningBalance: true,
        },
        brand,
      );
      expect(email.text).toContain(
        'Concepto: Saldo migrado · Ortodoncia · corte 15/03/2026',
      );
      expect(email.text).toContain(
        'Saldo pendiente tras este abono: $ 450.000',
      );
      expect(email.text).not.toMatch(/Plan:|Saldo del plan/);
    });

    it('DX-203: el que va al responsable lo saluda a él y dice de quién es el abono', () => {
      const email = renderEmail(
        'payment-receipt',
        { ...base, patientName: 'Tomás Ortiz', responsibleName: 'Claudia' },
        brand,
      );
      expect(email.text).toContain('Hola, Claudia');
      expect(email.text).toContain(
        'Te enviamos el recibo del abono de Tomás Ortiz en Sonrisas del Norte.',
      );
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

    it('DX-515-bis: con título y leyenda congelados, el asunto y el cuerpo los llevan', () => {
      const email = renderEmail(
        'payment-receipt',
        {
          ...base,
          title: 'Recibo de pago',
          legend: 'Este recibo no es una factura',
        },
        brand,
      );
      expect(email.subject).toBe(
        'Recibo de pago NOR-000123 · Sonrisas del Norte',
      );
      expect(email.text).toContain('Recibo de pago N.º NOR-000123');
      expect(email.text).not.toContain('Recibo de caja');
      const lines = email.text.split('\n');
      const titleAt = lines.findIndex((l) => l.includes('Recibo de pago N.º'));
      expect(lines[titleAt + 1]).toContain('Este recibo no es una factura');
      // El pie fijo de DX-136 sigue.
      expect(email.text).toContain('Este documento no es factura');
    });

    it('DX-515-bis: sin título ni leyenda, el email es el de antes, byte a byte', () => {
      const before = renderEmail('payment-receipt', base, brand);
      const same = renderEmail(
        'payment-receipt',
        { ...base, title: undefined, legend: undefined },
        brand,
      );
      expect(same).toEqual(before);
    });
  });

  describe('post-op-instructions (DX-222)', () => {
    const URL = 'https://sonrisas.dentalix.app/indicaciones/abc';
    const base = {
      patientFirstName: 'Carolina',
      clinicName: 'Sonrisas del Norte',
      locationPhone: '601 555 0101',
      url: URL,
      responsibleName: null,
    };

    it('saluda, enlaza las indicaciones y da el teléfono de la sede; asunto con la clínica', () => {
      const email = renderEmail('post-op-instructions', base, brand);
      expect(email.subject).toBe('Indicaciones de Sonrisas del Norte');
      expect(email.text).toContain('Hola, Carolina');
      expect(email.text).toContain(
        'Te enviamos tus indicaciones de cuidado tras tu visita a Sonrisas del Norte.',
      );
      expect(email.html).toContain(`href="${URL}"`);
      expect(email.text).toContain(`Ver indicaciones: ${URL}`);
      expect(email.text).toContain(
        'Si tienes dudas, llama a la sede al 601 555 0101.',
      );
    });

    it('al responsable lo saluda a él y dice de quién son; sin teléfono de sede no lo menciona', () => {
      const email = renderEmail(
        'post-op-instructions',
        {
          ...base,
          patientFirstName: 'Tomás',
          responsibleName: 'Claudia',
          locationPhone: null,
        },
        brand,
      );
      expect(email.text).toContain('Hola, Claudia');
      expect(email.text).toContain(
        'Te enviamos las indicaciones de cuidado de Tomás tras su visita a Sonrisas del Norte.',
      );
      expect(email.text).not.toContain('llama a la sede');
    });

    it('escapa lo variable y no lleva el título ni el texto de la plantilla', () => {
      const email = renderEmail(
        'post-op-instructions',
        {
          ...base,
          patientFirstName: '<b>Ana</b>',
          clinicName: 'Sonrisas <script>',
          locationPhone: '"601"',
          // Aunque alguien colara el título de la plantilla, no se pinta.
          ...{ title: 'Exodoncia', body: 'Exodoncia: muerde la gasa' },
        },
        brand,
      );
      expect(email.html).not.toContain('<b>Ana</b>');
      expect(email.html).not.toContain('<script>');
      expect(email.html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
      // Las variables no admiten el procedimiento: solo el enlace.
      for (const part of [email.subject, email.html, email.text]) {
        expect(part).not.toContain('Exodoncia');
      }
    });
  });

  // DX-128: baja de los recordatorios desde el propio email.
  it('appointment-reminder lleva el enlace de baja al pie (HTML y texto)', () => {
    const email = renderEmail(
      'appointment-reminder',
      {
        patientName: 'Carolina',
        startsAtLabel: 'martes 20 de octubre de 2026 a las 9:30 a. m.',
        locationName: 'Sede Norte',
        locationAddress: null,
        providerName: null,
        confirmUrl: 'https://demo.dentalix.app/confirmar/abc',
        unsubscribeUrl: 'https://demo.dentalix.app/baja/xyz',
      },
      brand,
    );
    expect(email.html).toContain('href="https://demo.dentalix.app/baja/xyz"');
    expect(email.html).toContain('Dejar de recibir recordatorios');
    expect(email.text).toContain(
      '¿No quieres recibir más recordatorios? Dejar de recibir recordatorios: https://demo.dentalix.app/baja/xyz',
    );
  });

  it('un enlace de baja que no es http(s) no sale en el email', () => {
    expect(() =>
      renderEmail(
        'appointment-reminder',
        {
          patientName: 'Carolina',
          startsAtLabel: 'martes 20 de octubre de 2026 a las 9:30 a. m.',
          locationName: 'Sede Norte',
          locationAddress: null,
          providerName: null,
          confirmUrl: null,
          unsubscribeUrl: 'javascript:alert(1)',
        },
        brand,
      ),
    ).toThrow('URL http(s) válida');
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
  describe('signature-request y signature-code (DX-243)', () => {
    const URL = 'https://sonrisas.dentalix.app/firmar/abc';

    it('el enlace: saluda, dice que se pedirá un código y cuándo caduca; nada clínico', () => {
      const email = renderEmail(
        'signature-request',
        {
          recipientFirstName: 'Laura',
          patientFirstName: null,
          clinicName: 'Sonrisas del Norte',
          url: URL,
          expiresAtLabel: '02/11/2026 9:30 a. m.',
        },
        brand,
      );
      expect(email.subject).toBe(
        'Sonrisas del Norte te envió un documento para firmar',
      );
      expect(email.text).toContain('Hola, Laura');
      expect(email.text).toContain('código de 6 dígitos');
      expect(email.text).toContain('El enlace caduca el 02/11/2026 9:30 a. m.');
      expect(email.html).toContain(`href="${URL}"`);
      expect(email.text).toContain(`Ver y firmar: ${URL}`);
      expect(email.text).not.toMatch(/consentimiento|exodoncia|tratamiento/i);
    });

    it('al responsable de un menor: le dice de quién es el documento', () => {
      const email = renderEmail(
        'signature-request',
        {
          recipientFirstName: 'Claudia',
          patientFirstName: 'Sofía',
          clinicName: 'Sonrisas del Norte',
          url: URL,
          expiresAtLabel: '02/11/2026 09:30',
        },
        brand,
      );
      expect(email.text).toContain('Hola, Claudia');
      expect(email.text).toContain('un documento de Sofía');
    });

    it('el código: solo el código, su caducidad y el aviso de no compartirlo; sin enlace', () => {
      const email = renderEmail(
        'signature-code',
        {
          recipientFirstName: 'Laura',
          clinicName: 'Sonrisas del Norte',
          code: '012345',
          expiresInMinutes: 10,
        },
        brand,
      );
      expect(email.subject).toBe('Tu código para firmar en Sonrisas del Norte');
      expect(email.text).toContain('Tu código de verificación es: 012345');
      expect(email.text).toContain('Caduca en 10 minutos');
      expect(email.html).not.toContain('href=');
    });

    it('la confirmación del presupuesto aceptado (DX-415): quién, clínica y hora; sin importes ni enlace', () => {
      const email = renderEmail(
        'signature-budget-accepted',
        {
          recipientFirstName: 'Laura',
          clinicName: 'Sonrisas del Norte',
          acceptedAtLabel: '31/10/2026 9:30 a. m.',
        },
        brand,
      );
      expect(email.subject).toBe('Sonrisas del Norte recibió tu aceptación');
      expect(email.text).toContain('Hola, Laura');
      expect(email.text).toContain(
        'El 31/10/2026 9:30 a. m. registramos tu aceptación',
      );
      expect(email.html).not.toContain('href=');
      expect(email.text).not.toMatch(/\$|\bCOP\b|implante|tratamiento/i);
    });

    it('la oferta de hueco por enlace (DX-435): cuándo, dónde y con quién; sin nada clínico', () => {
      const email = renderEmail(
        'slot-offer',
        {
          patientFirstName: 'Laura',
          clinicName: 'Sonrisas del Norte',
          slotLabel: 'lunes 2 de noviembre, 10:00 a. m.',
          locationName: 'Sede Centro',
          providerName: 'Dra. Gómez',
          url: 'https://demo.dentalix.app/hueco/abc',
          expiresAtLabel: '02/11/2026 10:00 a. m.',
        },
        brand,
      );
      expect(email.subject).toBe(
        'Sonrisas del Norte tiene un hueco libre para ti',
      );
      expect(email.text).toContain('Hola, Laura');
      expect(email.text).toContain('lunes 2 de noviembre, 10:00 a. m.');
      expect(email.text).toContain('Sede Centro');
      expect(email.text).toContain('Dra. Gómez');
      expect(email.text).toContain('el primero que lo acepte');
      expect(email.text).toContain('02/11/2026 10:00 a. m.');
      expect(email.html).toContain(
        'href="https://demo.dentalix.app/hueco/abc"',
      );
      expect(email.text).not.toMatch(/tratamiento|motivo/i);
    });

    it('la copia del PDF firmado (DX-443): enlace de un solo uso, sin título ni nada clínico', () => {
      const email = renderEmail(
        'signed-consent-copy',
        {
          recipientFirstName: 'Marta',
          patientFirstName: 'Lucía',
          clinicName: 'Sonrisas del Norte',
          url: 'https://demo.dentalix.app/copia/abc',
          expiresAtLabel: '07/11/2026 9:30 a. m.',
        },
        brand,
      );
      expect(email.subject).toBe(
        'Tu copia del documento firmado en Sonrisas del Norte',
      );
      expect(email.text).toContain('Hola, Marta');
      expect(email.text).toContain('firmaste en nombre de Lucía');
      expect(email.text).toContain('07/11/2026 9:30 a. m.');
      expect(email.text).toContain('solo sirve una vez');
      expect(email.html).toContain(
        'href="https://demo.dentalix.app/copia/abc"',
      );
      expect(email.text).not.toMatch(
        /consentimiento|tratamiento|procedimiento|exodoncia|diagn/i,
      );
    });

    it('la copia del PDF firmado al propio paciente no nombra a nadie más', () => {
      const email = renderEmail(
        'signed-consent-copy',
        {
          recipientFirstName: 'Laura',
          patientFirstName: null,
          clinicName: 'Sonrisas del Norte',
          url: 'https://demo.dentalix.app/copia/abc',
          expiresAtLabel: '07/11/2026 9:30 a. m.',
        },
        brand,
      );
      expect(email.text).toContain('Hola, Laura');
      expect(email.text).not.toContain('en nombre de');
    });
  });
});
