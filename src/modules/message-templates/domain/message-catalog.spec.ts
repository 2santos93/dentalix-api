import { EMAIL_LOCALES } from '../../notifications/email/domain/email-message';
import {
  MESSAGE_CATALOG,
  MESSAGE_CHANNELS,
  MESSAGE_KEYS,
  MESSAGE_LANGUAGES,
  defaultMessageText,
  offeredMessageLanguages,
} from './message-catalog';
import { validateMessageTemplate } from './message-template-engine';
import {
  FORBIDDEN_MESSAGE_VARIABLES,
  MESSAGE_VARIABLES,
  MESSAGE_VARIABLE_INFO,
  type MessageValues,
} from './message-variables';

// Lo que un mensaje al paciente puede contar: quién, dónde, cuándo, con quién
// y el enlace. Nada de importes, tratamientos, diagnósticos ni de otro paciente.
const ALLOWED_DATA = new Set([
  'paciente',
  'clinica',
  'sede',
  'direccion',
  'fecha',
  'hora',
  'profesional',
  'enlace',
  'caduca',
  'cantidad',
]);

describe('DX-565: catálogo de mensajes editables', () => {
  it('es la porción 1 cerrada: 6 claves con sus canales', () => {
    expect(
      Object.fromEntries(
        MESSAGE_KEYS.map((k) => [k, Object.keys(MESSAGE_CATALOG[k].channels)]),
      ),
    ).toEqual({
      'appointment-reminder': ['EMAIL'],
      'appointment-confirmation': ['WHATSAPP'],
      'slot-offer': ['EMAIL', 'WHATSAPP'],
      'quote-follow-up': ['EMAIL'],
      'appointment-series': ['EMAIL'],
      'signature-request': ['EMAIL'],
    });
  });

  it('las variables son solo datos permitidos (ninguna de importes ni clínica)', () => {
    expect([...MESSAGE_VARIABLES].sort()).toEqual([...ALLOWED_DATA].sort());
    for (const v of MESSAGE_VARIABLES) {
      expect(FORBIDDEN_MESSAGE_VARIABLES).not.toContain(v);
      expect(MESSAGE_VARIABLE_INFO[v].description).toBeTruthy();
      expect(MESSAGE_VARIABLE_INFO[v].sample).toBeTruthy();
    }
  });

  it('el contexto de render no tiene sitio para un importe (tipo cerrado)', () => {
    // @ts-expect-error `importe` no es una variable: el tipo no la admite.
    const values: MessageValues = { importe: '20,00 USD' };
    expect(values).toBeDefined();
  });

  it('cada canal: variables del catálogo, obligatorias entre sus variables y {enlace} solo en WhatsApp (obligatorio)', () => {
    for (const key of MESSAGE_KEYS) {
      for (const channel of MESSAGE_CHANNELS) {
        const spec = MESSAGE_CATALOG[key].channels[channel];
        if (!spec) continue;
        for (const v of spec.variables) expect(ALLOWED_DATA.has(v)).toBe(true);
        for (const r of spec.required) expect(spec.variables).toContain(r);
        expect(spec.variables.includes('enlace')).toBe(channel === 'WHATSAPP');
        expect(spec.required.includes('enlace')).toBe(channel === 'WHATSAPP');
        expect(Object.keys(spec.defaults)).toContain('es');
      }
    }
  });

  it('todo texto por defecto pasa su propia validación sin cambiar', () => {
    for (const key of MESSAGE_KEYS) {
      for (const channel of MESSAGE_CHANNELS) {
        for (const language of MESSAGE_LANGUAGES) {
          const text = defaultMessageText(key, channel, language);
          if (!text) continue;
          expect([key, channel, language, validateMessageTemplate(key, channel, text)]).toEqual([
            key,
            channel,
            language,
            { ok: true, text },
          ]);
        }
      }
    }
  });

  it('los idiomas del catálogo son los de los emails', () => {
    expect([...MESSAGE_LANGUAGES]).toEqual([...EMAIL_LOCALES]);
  });

  it('idiomas ofrecidos: español siempre; inglés si la clínica ofrece alguna variante', () => {
    expect(offeredMessageLanguages(['es'])).toEqual(['es']);
    expect(offeredMessageLanguages([])).toEqual(['es']);
    expect(offeredMessageLanguages(['es', 'en-US', 'pt-BR'])).toEqual([
      'es',
      'en',
    ]);
    expect(offeredMessageLanguages(['ca'])).toEqual(['es']);
  });
});
