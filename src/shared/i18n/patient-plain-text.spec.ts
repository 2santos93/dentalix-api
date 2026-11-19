import {
  hasLinkOrHtml,
  normalizePatientPlainText,
  patientPlainTextFromEntries,
  type PatientPlainTextRules,
} from './patient-plain-text';
import { LANGUAGE_TAG_MESSAGE } from './patient-language';

// DX-560: la regla de DX-564 extraída a `shared/`. Los casos finos de enlaces
// siguen en `appointment-type-rules.spec.ts` (mismo código); aquí, lo que
// cada uso parametriza (tope, idiomas, mensajes) y una muestra de la regla.

const RULES: PatientPlainTextRules = {
  textMax: 10,
  maxLanguages: 2,
  totalBytesMax: 60,
  messages: {
    tooMany: 'muchos',
    repeated: 'repetido',
    languageNotOffered: 'no ofrecido',
    tooLong: 'largo',
    noLinks: 'enlace',
    tooLarge: 'grande',
  },
};
const CTX = { patientLanguages: ['es', 'en'], current: {} };

describe('patientPlainTextFromEntries', () => {
  it('canoniza, descarta los vacíos y devuelve el mapa', () => {
    expect(
      patientPlainTextFromEntries(
        [
          { language: 'EN', text: '  Hola \r\n ' },
          { language: 'es', text: '   ' },
        ],
        CTX,
        RULES,
      ),
    ).toEqual({ map: { en: 'Hola' } });
  });

  it.each([
    [[{ language: 'xx-!!', text: 'a' }], LANGUAGE_TAG_MESSAGE],
    [
      [
        { language: 'es', text: 'a' },
        { language: 'ES', text: 'b' },
      ],
      'repetido',
    ],
    [
      [
        { language: 'es', text: 'a' },
        { language: 'en', text: 'b' },
        { language: 'pt', text: 'c' },
      ],
      'muchos',
    ],
    [[{ language: 'pt', text: 'a' }], 'no ofrecido'],
    [[{ language: 'es', text: '12345678901' }], 'largo'],
    [[{ language: 'es', text: 'ver x.com' }], 'enlace'],
  ])('rechaza %j con su mensaje', (entries, error) => {
    expect(patientPlainTextFromEntries(entries, CTX, RULES)).toEqual({
      error,
    });
  });

  it('el tope en conjunto, en bytes del JSON', () => {
    const rules = { ...RULES, totalBytesMax: 20 };
    expect(
      patientPlainTextFromEntries(
        [
          { language: 'es', text: 'ñññññññññ' },
          { language: 'en', text: 'b' },
        ],
        CTX,
        rules,
      ),
    ).toEqual({ error: 'grande' });
  });

  it('un idioma ya retirado se conserva si el texto no cambia', () => {
    expect(
      patientPlainTextFromEntries(
        [{ language: 'pt', text: 'Olá' }],
        { patientLanguages: ['es'], current: { pt: 'Olá' } },
        RULES,
      ),
    ).toEqual({ map: { pt: 'Olá' } });
  });
});

describe('hasLinkOrHtml / normalizePatientPlainText', () => {
  it.each([
    'https://a.b',
    'www.x',
    '<b>x</b>',
    'bit.ly/x',
    '10.0.0.1',
    'a@b.co',
  ])('marca %s', (text) => expect(hasLinkOrHtml(text)).toBe(true));
  it.each(['Dr.Pérez', '10.30 h', '1.5 ml', 'p.ej. limpieza'])(
    'no marca %s',
    (text) => expect(hasLinkOrHtml(text)).toBe(false),
  );
  it.each([
    'evil\u3002com/x',
    'evil\uFF0Ecom/x',
    'bit\uFF61ly',
    'evil\uFE52com',
    'pagos\u2024com',
    'ｗｗｗ.x',
  ])(
    'DX-565: un punto parecido (o letras de ancho completo) cuenta como enlace: %s',
    (text) => expect(hasLinkOrHtml(text)).toBe(true),
  );
  it('DX-565: un 。 entre frases en japonés o chino sin TLD no es enlace', () => {
    expect(hasLinkOrHtml('ご来院ください。ありがとう')).toBe(false);
  });
  it('quita el formato invisible que parte un enlace', () => {
    const zwsp = String.fromCharCode(0x200b);
    expect(normalizePatientPlainText(`x${zwsp}.com`)).toBe('x.com');
  });
});
