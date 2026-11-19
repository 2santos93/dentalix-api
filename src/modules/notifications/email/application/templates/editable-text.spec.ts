import { regionalFormat } from '../../../../../shared/format/regional-format';
import {
  defaultMessageText,
  MESSAGE_LANGUAGES,
  type MessageLanguage,
} from '../../../../message-templates/domain/message-catalog';
import type {
  AppointmentReminderEmailVars,
  AppointmentSeriesEmailVars,
  EmailBrand,
  EmailVarsByTemplate,
  QuoteFollowUpEmailVars,
  SignatureRequestEmailVars,
  SlotOfferEmailVars,
} from '../../domain/email-message';
import {
  EDITABLE_EMAIL_TEMPLATES,
  splitDateTimeLabel,
  type EditableEmailTemplate,
} from './editable-text';
import { renderEmail } from './templates';

const BRAND: EmailBrand = {
  clinicName: 'Clínica Dental Altamira',
  logoUrl: null,
  primaryColor: '#0F5E9C',
};

const reminder = (
  over: Partial<AppointmentReminderEmailVars> = {},
): AppointmentReminderEmailVars => ({
  patientName: 'Ana',
  guardianName: null,
  startsAtLabel: 'martes 20 de octubre de 2026 a las 9:30 a. m.',
  locationName: 'Sede Altamira',
  locationAddress: 'Av. Francisco de Miranda 93',
  providerName: 'Dra. Laura Gómez',
  confirmUrl: 'https://demo.dentalix.app/confirmar/tok',
  unsubscribeUrl: 'https://demo.dentalix.app/baja/tok',
  calendar: null,
  cancellationPolicy: { noticeHours: 24, text: '', feeLabel: '20,00 USD' },
  ...over,
});

const slot = (over: Partial<SlotOfferEmailVars> = {}): SlotOfferEmailVars => ({
  patientFirstName: 'Ana',
  clinicName: 'Clínica Dental Altamira',
  slotLabel: 'martes 20 de octubre de 2026 a las 9:30 a. m.',
  locationName: 'Sede Altamira',
  providerName: 'Dra. Laura Gómez',
  url: 'https://demo.dentalix.app/hueco/tok',
  expiresAtLabel: 'martes 20 de octubre de 2026 a las 8:30 a. m.',
  ...over,
});

const quote = (
  over: Partial<QuoteFollowUpEmailVars> = {},
): QuoteFollowUpEmailVars => ({
  recipientFirstName: 'Ana',
  patientFirstName: null,
  clinicName: 'Clínica Dental Altamira',
  urls: ['https://demo.dentalix.app/firmar/a'],
  expiresInHours: 72,
  unsubscribeUrl: 'https://demo.dentalix.app/baja/tok',
  ...over,
});

const series = (
  over: Partial<AppointmentSeriesEmailVars> = {},
): AppointmentSeriesEmailVars => ({
  recipientFirstName: 'Ana',
  patientFirstName: null,
  clinicName: 'Clínica Dental Altamira',
  locationName: 'Sede Altamira',
  providerName: 'Dra. Laura Gómez',
  dateLabels: [
    'martes 20 de octubre a las 9:30',
    'martes 27 de octubre a las 9:30',
  ],
  unsubscribeUrl: null,
  ...over,
});

const signature = (
  over: Partial<SignatureRequestEmailVars> = {},
): SignatureRequestEmailVars => ({
  recipientFirstName: 'Ana',
  patientFirstName: null,
  clinicName: 'Clínica Dental Altamira',
  url: 'https://demo.dentalix.app/firmar/tok',
  expiresAtLabel: 'jueves 22 de octubre de 2026 a las 6:00 p. m.',
  ...over,
});

/** Las combinaciones de datos que el texto por defecto debe cubrir. */
const CASES: {
  [T in EditableEmailTemplate]: EmailVarsByTemplate[T][];
} = {
  'appointment-reminder': [
    reminder(),
    reminder({ locationAddress: null }),
    reminder({ providerName: null }),
    reminder({ providerName: null, locationAddress: null, confirmUrl: null }),
    reminder({ startsAtLabel: 'martes 20 de octubre de 2026 a las 15:05' }),
    // Revisión: sin «a las» en la etiqueta, y un profesional que acaba en «.».
    reminder({ startsAtLabel: 'mañana' }),
    reminder({ providerName: 'Dr. J. P.' }),
  ],
  'slot-offer': [
    slot(),
    slot({ providerName: null }),
    slot({ providerName: 'Dr. J. P.' }),
    slot({ slotLabel: 'mañana' }),
  ],
  'quote-follow-up': [
    quote(),
    quote({ recipientFirstName: null }),
    quote({
      urls: [
        'https://demo.dentalix.app/firmar/a',
        'https://demo.dentalix.app/firmar/b',
      ],
    }),
  ],
  'appointment-series': [
    series(),
    series({ providerName: null }),
    series({
      dateLabels: Array.from(
        { length: 26 },
        (_, i) => `martes ${i + 1} de octubre a las 9:30`,
      ),
    }),
  ],
  'signature-request': [signature()],
};

function languagesOf(template: EditableEmailTemplate): MessageLanguage[] {
  return MESSAGE_LANGUAGES.filter(
    (l) => defaultMessageText(template, 'EMAIL', l) !== null,
  );
}

describe('DX-565: texto de la clínica en los emails editables', () => {
  describe('el texto por defecto del catálogo sale IGUAL que el de siempre', () => {
    for (const template of EDITABLE_EMAIL_TEMPLATES) {
      for (const language of languagesOf(template)) {
        it(`${template} (${language})`, () => {
          const text = defaultMessageText(template, 'EMAIL', language)!;
          // Revisión: también con un nombre de clínica que acaba en «.».
          for (const brand of [
            BRAND,
            { ...BRAND, clinicName: 'Odontología C.A.' },
          ]) {
            for (const base of CASES[template] as object[]) {
              const vars = (
                'clinicName' in base
                  ? { ...base, clinicName: brand.clinicName }
                  : base
              ) as never;
              expect(
                renderEmail(template, vars, brand, language, text),
              ).toEqual(renderEmail(template, vars, brand, language));
            }
          }
        });
      }
    }
  });

  it('con texto propio cambia el asunto y los párrafos; el resto del email es fijo', () => {
    const email = renderEmail('appointment-reminder', reminder(), BRAND, 'es', {
      subject: 'Tu cita del {fecha}',
      body: 'Hola {paciente}, te esperamos el {fecha} a las {hora}[ con {profesional}].\n\nTrae tu documento de identidad.',
    });
    expect(email.subject).toBe('Tu cita del martes 20 de octubre de 2026');
    expect(email.text).toContain(
      'Hola Ana, te esperamos el martes 20 de octubre de 2026 a las 9:30 a. m. con Dra. Laura Gómez.',
    );
    expect(email.text).not.toContain('Te recordamos tu cita');
    // Fijos: saludo, botón, política y baja.
    expect(email.text).toContain('Hola, Ana');
    expect(email.text).toContain('Confirmar o cancelar');
    expect(email.text).toContain('Política de cancelación');
    expect(email.text).toContain('Dejar de recibir recordatorios');
  });

  it('escapa el HTML del texto de la clínica y de los valores', () => {
    const email = renderEmail(
      'slot-offer',
      slot({ patientFirstName: 'Ana <b>' }),
      BRAND,
      'es',
      {
        subject: 'Hueco para {paciente}',
        body: 'Hola {paciente}, 2 < 3 & más',
      },
    );
    expect(email.html).toContain('Hola Ana &lt;b&gt;, 2 &lt; 3 &amp; más');
    expect(email.html).not.toContain('<b>,');
    expect(email.subject).toBe('Hueco para Ana <b>');
  });

  it('cada línea en blanco es un párrafo y los saltos simples se conservan', () => {
    const email = renderEmail('quote-follow-up', quote(), BRAND, 'es', {
      subject: 'Presupuesto en {clinica}',
      body: 'Línea uno\nlínea dos\n\nOtro párrafo',
    });
    expect(email.html).toContain('Línea uno<br />línea dos');
    // Dos párrafos (dos <p>); en el texto plano, un bloque por línea.
    expect(email.html).toMatch(/línea dos<\/p>\s*<p[^>]*>Otro párrafo<\/p>/);
    expect(email.text).toContain('Línea uno\nlínea dos\nOtro párrafo');
  });

  it('al responsable de un menor le sigue llegando el texto de siempre, también en inglés', () => {
    const custom = { subject: 'Your visit', body: 'Custom text.' };
    expect(
      renderEmail(
        'appointment-reminder',
        reminder({ guardianName: 'Carlos' }),
        BRAND,
        'en',
        custom,
      ),
    ).toEqual(
      renderEmail(
        'appointment-reminder',
        reminder({ guardianName: 'Carlos' }),
        BRAND,
        'en',
      ),
    );
  });

  it('al responsable de un menor le sigue llegando el texto de siempre', () => {
    const custom = { subject: 'Asunto propio', body: 'Cuerpo propio' };
    expect(
      renderEmail(
        'appointment-reminder',
        reminder({ guardianName: 'Carlos' }),
        BRAND,
        'es',
        custom,
      ),
    ).toEqual(
      renderEmail(
        'appointment-reminder',
        reminder({ guardianName: 'Carlos' }),
        BRAND,
        'es',
      ),
    );
    for (const [template, vars] of [
      ['quote-follow-up', quote({ patientFirstName: 'Luis' })],
      ['appointment-series', series({ patientFirstName: 'Luis' })],
      ['signature-request', signature({ patientFirstName: 'Luis' })],
    ] as const) {
      expect(renderEmail(template, vars as never, BRAND, 'es', custom)).toEqual(
        renderEmail(template, vars as never, BRAND, 'es'),
      );
    }
  });

  it('un texto guardado que ya no es válido cae al de siempre (nunca sale una {variable} cruda)', () => {
    expect(
      renderEmail('appointment-reminder', reminder(), BRAND, 'es', {
        subject: 'Hola',
        body: 'Pagas {importe}',
      }),
    ).toEqual(renderEmail('appointment-reminder', reminder(), BRAND, 'es'));
  });

  it('la serie conserva su lista de fechas fija', () => {
    const email = renderEmail('appointment-series', series(), BRAND, 'es', {
      subject: 'Tus citas',
      body: 'Te esperamos {cantidad} veces.',
    });
    expect(email.text).toContain('Te esperamos 2 veces.');
    expect(email.text).toContain('1. martes 20 de octubre a las 9:30');
  });

  it('la solicitud de firma conserva el aviso del código y sale en inglés', () => {
    const email = renderEmail('signature-request', signature(), BRAND, 'en');
    expect(email.subject).toBe(
      'Clínica Dental Altamira sent you a document to sign',
    );
    expect(email.html).toContain('<html lang="en">');
    expect(email.text).toContain('6-digit code');
    expect(email.text).toContain('Hello Ana,');
  });

  describe('splitDateTimeLabel sigue a RegionalFormat.longDateTime', () => {
    const instant = new Date('2026-10-20T13:30:00Z');
    it.each(['h12', 'h23'] as const)('reloj %s', (hourCycle) => {
      const fmt = regionalFormat({ locale: 'es-VE', hourCycle });
      const label = fmt.longDateTime(instant, 'America/Caracas');
      expect(splitDateTimeLabel(label)).toEqual({
        fecha: fmt.longDate(instant, 'America/Caracas'),
        hora: fmt.time(instant, 'America/Caracas'),
      });
    });
    it('sin «a las», todo es la fecha', () => {
      expect(splitDateTimeLabel('mañana')).toEqual({
        fecha: 'mañana',
        hora: '',
      });
    });
  });
});
