import {
  MESSAGE_BODY_EMPTY_MESSAGE,
  MESSAGE_BRACES_MESSAGE,
  MESSAGE_BRACKETS_MESSAGE,
  MESSAGE_EMAIL_LINKS_MESSAGE,
  MESSAGE_MULTILINE_OPTIONAL_MESSAGE,
  MESSAGE_SUBJECT_EMPTY_MESSAGE,
  MESSAGE_WHATSAPP_LINKS_MESSAGE,
  MESSAGE_WHATSAPP_SUBJECT_MESSAGE,
  messageParagraphs,
  renderMessageTemplate,
  validateMessageTemplate,
} from './message-template-engine';
import type { MessageValues } from './message-variables';

const VALUES: MessageValues = {
  paciente: 'Ana',
  clinica: 'Clínica Dental Altamira',
  sede: 'Sede Altamira',
  direccion: 'Av. Francisco de Miranda 93',
  fecha: 'martes 20 de octubre de 2026',
  hora: '9:30 a. m.',
  profesional: 'Dra. Laura Gómez',
  enlace: 'https://demo.dentalix.app/confirmar/tok',
};

const email = (body: string, subject: string | null = 'Asunto') =>
  validateMessageTemplate('appointment-reminder', 'EMAIL', { subject, body });
const wa = (body: string, subject?: string | null) =>
  validateMessageTemplate('appointment-confirmation', 'WHATSAPP', {
    subject,
    body,
  });
const render = (body: string, values: MessageValues = VALUES) => {
  const r = renderMessageTemplate(
    'appointment-confirmation',
    'WHATSAPP',
    'es',
    { subject: null, body },
    values,
  );
  return r.ok ? r.text.body : undefined;
};

describe('DX-565: motor de textos de los mensajes al paciente', () => {
  describe('render', () => {
    it('sustituye cada {variable} por su valor', () => {
      expect(render('Hola {paciente}, aquí: {enlace}')).toBe(
        'Hola Ana, aquí: https://demo.dentalix.app/confirmar/tok',
      );
    });

    it('una sola pasada: un valor con {llaves} o [corchetes] sale tal cual', () => {
      expect(
        render('Hola {paciente}: {enlace}', {
          ...VALUES,
          paciente: '{enlace} [x]',
        }),
      ).toBe('Hola {enlace} [x]: https://demo.dentalix.app/confirmar/tok');
    });

    it('un tramo opcional sale solo si TODAS sus variables tienen valor', () => {
      const body =
        'Hola[ {paciente}], cita[ con {profesional}][ en {sede} ({direccion})]: {enlace}';
      expect(render(body)).toBe(
        'Hola Ana, cita con Dra. Laura Gómez en Sede Altamira (Av. Francisco de Miranda 93): https://demo.dentalix.app/confirmar/tok',
      );
      expect(
        render(body, {
          ...VALUES,
          paciente: '  ',
          profesional: null,
          direccion: undefined,
        }),
      ).toBe('Hola, cita: https://demo.dentalix.app/confirmar/tok');
    });

    it('fuera de un tramo, una variable sin valor sale vacía', () => {
      expect(render('Con {profesional}. {enlace}', { enlace: 'x' })).toBe(
        'Con . x',
      );
    });

    it('no dobla el punto tras un valor que ya acaba en punto (como endSentence)', () => {
      expect(render('A las {hora}. Aquí: {enlace}')).toBe(
        'A las 9:30 a. m. Aquí: https://demo.dentalix.app/confirmar/tok',
      );
      expect(
        render('A las {hora}[ con {profesional}]. {enlace}', {
          ...VALUES,
          profesional: null,
        }),
      ).toBe('A las 9:30 a. m. https://demo.dentalix.app/confirmar/tok');
      // El punto que escribe la clínica tras su propio texto, intacto.
      expect(render('Fin... {enlace}')).toBe(
        'Fin... https://demo.dentalix.app/confirmar/tok',
      );
    });

    it('conserva los saltos de línea; los párrafos se separan por una línea en blanco', () => {
      expect(render('Hola {paciente}\nlínea dos\n\nOtro: {enlace}')).toBe(
        'Hola Ana\nlínea dos\n\nOtro: https://demo.dentalix.app/confirmar/tok',
      );
      expect(messageParagraphs('Uno\ndos\n\n\n  \n\nTres\n\n')).toEqual([
        'Uno\ndos',
        'Tres',
      ]);
    });

    it('un texto no válido no se renderiza (null): quien llama usa el de siempre', () => {
      expect(render('Hola {importe} {enlace}')).toBeUndefined();
      expect(render('Hola {paciente')).toBeUndefined();
    });

    it('renderiza el asunto en una línea', () => {
      expect(
        renderMessageTemplate(
          'appointment-reminder',
          'EMAIL',
          'es',
          { subject: 'Cita en {clinica}\n el {fecha}', body: 'Hola' },
          VALUES,
        ),
      ).toEqual({
        ok: true,
        text: {
          subject:
            'Cita en Clínica Dental Altamira el martes 20 de octubre de 2026',
          body: 'Hola',
        },
      });
    });
  });

  describe('validación (400 con el motivo y el campo)', () => {
    it('normaliza: recorta, quita controles y deja como mucho una línea en blanco', () => {
      expect(email('  Hola\r\n\r\n\r\n\r\nAdiós​  ')).toEqual({
        ok: true,
        text: { subject: 'Asunto', body: 'Hola\n\nAdiós' },
      });
    });

    it('variable desconocida', () => {
      expect(email('Hola {nombre}')).toEqual({
        ok: false,
        field: 'body',
        message: 'La variable {nombre} no existe.',
      });
    });

    it('importes y datos clínicos: «no se puede usar», nunca «no existe»', () => {
      expect(email('Debes {importe}')).toEqual({
        ok: false,
        field: 'body',
        message:
          '{importe} no se puede usar en el recordatorio: los mensajes al paciente no llevan importes ni datos clínicos.',
      });
      expect(email('Tu {Tratamiento}')).toEqual({
        ok: false,
        field: 'body',
        message:
          '{Tratamiento} no se puede usar en el recordatorio: los mensajes al paciente no llevan importes ni datos clínicos.',
      });
    });

    it('variable que existe pero no es de ese mensaje', () => {
      expect(email('Tu enlace: {enlace}')).toEqual({
        ok: false,
        field: 'body',
        message: '{enlace} no se puede usar en el recordatorio.',
      });
      expect(
        validateMessageTemplate('quote-follow-up', 'EMAIL', {
          subject: 'Hola',
          body: 'Tu cita del {fecha}',
        }),
      ).toEqual({
        ok: false,
        field: 'body',
        message: '{fecha} no se puede usar en el seguimiento del presupuesto.',
      });
    });

    it('{enlace} es obligatorio en WhatsApp y no vale dentro de un tramo opcional', () => {
      const missing = {
        ok: false,
        field: 'body',
        message: 'La confirmación por WhatsApp tiene que llevar {enlace}.',
      };
      expect(wa('Hola {paciente}')).toEqual(missing);
      expect(wa('Hola[ aquí: {enlace}]')).toEqual(missing);
      expect(wa('Hola {paciente}: {enlace}')).toEqual({
        ok: true,
        text: { subject: null, body: 'Hola {paciente}: {enlace}' },
      });
    });

    it('longitudes: asunto 150, email 2000, WhatsApp 1000 (en caracteres)', () => {
      expect(email('x'.repeat(2000))).toMatchObject({ ok: true });
      expect(email('x'.repeat(2001))).toEqual({
        ok: false,
        field: 'body',
        message: 'El texto no puede pasar de 2000 caracteres.',
      });
      expect(email('ñ'.repeat(2000))).toMatchObject({ ok: true });
      expect(wa(`${'x'.repeat(991)} {enlace}`)).toMatchObject({ ok: true });
      expect(wa(`${'x'.repeat(992)} {enlace}`)).toEqual({
        ok: false,
        field: 'body',
        message: 'El texto no puede pasar de 1000 caracteres.',
      });
      expect(email('Hola', 'a'.repeat(150))).toMatchObject({ ok: true });
      expect(email('Hola', 'a'.repeat(151))).toEqual({
        ok: false,
        field: 'subject',
        message: 'El asunto no puede pasar de 150 caracteres.',
      });
    });

    it('vacíos', () => {
      expect(email('  \n ')).toEqual({
        ok: false,
        field: 'body',
        message: MESSAGE_BODY_EMPTY_MESSAGE,
      });
      expect(email('Hola', ' ')).toEqual({
        ok: false,
        field: 'subject',
        message: MESSAGE_SUBJECT_EMPTY_MESSAGE,
      });
      expect(email('Hola', null)).toMatchObject({ field: 'subject' });
    });

    it('WhatsApp no lleva asunto', () => {
      expect(wa('{enlace}', 'Asunto')).toEqual({
        ok: false,
        field: 'subject',
        message: MESSAGE_WHATSAPP_SUBJECT_MESSAGE,
      });
      expect(wa('{enlace}', '')).toMatchObject({ ok: true });
    });

    it.each([
      'Entra en https://ejemplo.com',
      'Mira www.ejemplo.com',
      'Escribe a ana@ejemplo.com',
      'Visita ejemplo.com.ve',
      'Hola <b>Ana</b>',
      '<a href="x">aquí</a>',
    ])('enlaces o HTML escritos a mano: %s', (body) => {
      expect(email(body)).toEqual({
        ok: false,
        field: 'body',
        message: MESSAGE_EMAIL_LINKS_MESSAGE,
      });
      expect(wa(`${body} {enlace}`)).toEqual({
        ok: false,
        field: 'body',
        message: MESSAGE_WHATSAPP_LINKS_MESSAGE,
      });
    });

    it('enlaces en el asunto', () => {
      expect(email('Hola', 'Ve a www.ejemplo.com')).toEqual({
        ok: false,
        field: 'subject',
        message: MESSAGE_EMAIL_LINKS_MESSAGE,
      });
    });

    it('{enlace} y variables no permitidas en el asunto', () => {
      expect(
        validateMessageTemplate('slot-offer', 'EMAIL', {
          subject: 'Hola {enlace}',
          body: 'Hola',
        }),
      ).toEqual({
        ok: false,
        field: 'subject',
        message: '{enlace} no se puede usar en el asunto.',
      });
    });

    it.each([
      'Hola {paciente',
      'Hola paciente}',
      'Hola {}',
      'Hola {pa{ciente}',
    ])('llaves mal cerradas: %s', (body) => {
      expect(email(body)).toEqual({
        ok: false,
        field: 'body',
        message: MESSAGE_BRACES_MESSAGE,
      });
    });

    it.each([
      'Hola [ con {profesional}',
      'Hola ]',
      'Hola [sin variable]',
      '[[ {sede}]]',
    ])('corchetes mal usados: %s', (body) => {
      expect(email(body)).toEqual({
        ok: false,
        field: 'body',
        message: MESSAGE_BRACKETS_MESSAGE,
      });
    });

    it('un tramo opcional no ocupa varias líneas', () => {
      expect(email('Hola [ con\n{profesional}]')).toEqual({
        ok: false,
        field: 'body',
        message: MESSAGE_MULTILINE_OPTIONAL_MESSAGE,
      });
    });

    it('lanza si el canal no es de esa clave (error de quien llama)', () => {
      expect(() =>
        validateMessageTemplate('appointment-reminder', 'WHATSAPP', {
          body: 'x',
        }),
      ).toThrow();
    });
  });

  describe('revisión: enlaces armados con las variables (H1)', () => {
    it.each([
      'Paga tu cita en pagos-clinica{profesional}.com/pagar',
      'Paga en pagos{direccion}.com',
      'Paga en bit[{profesional}].ly',
      'Escríbenos a {profesional}.com',
      'Paga en evil[ {sede}]{direccion}.com',
    ])('al guardar se rechaza: %s', (body) => {
      expect(email(body)).toEqual({
        ok: false,
        field: 'body',
        message: MESSAGE_EMAIL_LINKS_MESSAGE,
      });
    });

    it('también en WhatsApp y en el asunto', () => {
      expect(
        wa('Hola {paciente}, paga en evil{direccion}.com {enlace}'),
      ).toEqual({
        ok: false,
        field: 'body',
        message: MESSAGE_WHATSAPP_LINKS_MESSAGE,
      });
      expect(email('Hola', 'Paga en pagos{sede}.com')).toEqual({
        ok: false,
        field: 'subject',
        message: MESSAGE_EMAIL_LINKS_MESSAGE,
      });
    });

    it('{enlace} pegado a texto no cuenta como enlace armado (es el legítimo)', () => {
      expect(wa('Aquí:{enlace}.')).toMatchObject({ ok: true });
    });

    it('al enviar: si los datos arman un enlace que el texto por defecto no tiene, sale el de por defecto (LINK)', () => {
      const text = { subject: 'Hola {paciente}', body: 'Hola {paciente}.' };
      const values = { ...VALUES, paciente: 'evil.com' };
      expect(
        renderMessageTemplate('slot-offer', 'EMAIL', 'es', text, values),
      ).toEqual({ ok: false, reason: 'LINK' });
      // Si el de por defecto lleva el mismo dato, el dato no es del texto.
      expect(
        renderMessageTemplate(
          'slot-offer',
          'EMAIL',
          'es',
          { subject: 'Hueco en {clinica}', body: 'En {sede}.' },
          { ...VALUES, sede: 'Sede pagos.com', clinica: 'Clínica X' },
        ),
      ).toMatchObject({ ok: true });
    });

    it('un «<» en un dato no es motivo de caer al de por defecto', () => {
      expect(
        renderMessageTemplate(
          'slot-offer',
          'EMAIL',
          'es',
          { subject: 'Hola {paciente}', body: 'Hola {paciente}.' },
          { ...VALUES, paciente: 'Ana <b>' },
        ),
      ).toMatchObject({ ok: true });
    });
  });

  describe('revisión: topes del texto renderizado (H2, H12)', () => {
    it('WhatsApp: al guardar, el peor caso no puede pasar de 1300', () => {
      const body = `${'{direccion}{sede}{profesional}{fecha}'.repeat(4)} {enlace}`;
      expect(body.length).toBeLessThan(1000);
      expect(wa(body)).toEqual({
        ok: false,
        field: 'body',
        message:
          'El texto puede pasar de 1300 caracteres con los datos más largos (nombres, sede, dirección): acórtalo o usa menos variables.',
      });
    });

    it('asunto: al guardar, el peor caso no puede pasar de 200', () => {
      expect(email('Hola', '{direccion} {sede}')).toEqual({
        ok: false,
        field: 'subject',
        message:
          'El asunto puede pasar de 200 caracteres con los datos más largos (nombres, sede, dirección): acórtalo o usa menos variables.',
      });
    });

    it('al enviar, un dato fuera de lo razonable que pasa el tope: sale el de por defecto (TOO_LONG)', () => {
      expect(
        renderMessageTemplate(
          'appointment-reminder',
          'EMAIL',
          'es',
          { subject: 'Cita en {sede}', body: 'Hola' },
          { ...VALUES, sede: 's'.repeat(300) },
        ),
      ).toEqual({ ok: false, reason: 'TOO_LONG' });
      expect(
        renderMessageTemplate(
          'appointment-confirmation',
          'WHATSAPP',
          'es',
          { subject: null, body: '{direccion} {enlace}' },
          { ...VALUES, direccion: 'd'.repeat(1400) },
        ),
      ).toEqual({ ok: false, reason: 'TOO_LONG' });
    });

    it('un texto guardado que ya no es válido: INVALID', () => {
      expect(
        renderMessageTemplate(
          'appointment-reminder',
          'EMAIL',
          'es',
          { subject: 'Hola', body: 'Pagas {importe}' },
          VALUES,
        ),
      ).toEqual({ ok: false, reason: 'INVALID' });
    });
  });

  describe('el punto final, como el texto de siempre', () => {
    it('tras {hora} o {caduca} no se dobla; tras otra variable sí (como el código de siempre)', () => {
      const r = renderMessageTemplate(
        'quote-follow-up',
        'EMAIL',
        'es',
        { subject: 'Hola', body: 'En {clinica}.' },
        { clinica: 'Odontología C.A.' },
      );
      expect(r).toEqual({
        ok: true,
        text: { subject: 'Hola', body: 'En Odontología C.A..' },
      });
    });

    it('en la oferta por WhatsApp (endSentence) no se dobla tras ninguna', () => {
      const r = renderMessageTemplate(
        'slot-offer',
        'WHATSAPP',
        'es',
        { subject: null, body: 'Con {profesional}. {enlace}' },
        { profesional: 'Dr. J. P.', enlace: 'https://x.co/h' },
      );
      expect(r).toMatchObject({
        ok: true,
        text: { body: 'Con Dr. J. P. https://x.co/h' },
      });
    });
  });
});
