import {
  localizedTextEntries,
  localizedTextMapFromJson,
  resolveLocalizedText,
} from './localized-text';

describe('resolveLocalizedText (DX-564)', () => {
  const both = { es: 'Ven en ayunas.', en: 'Come fasting.' };

  it('idioma exacto del paciente', () => {
    expect(resolveLocalizedText(both, 'en')).toEqual({
      text: 'Come fasting.',
      language: 'en',
      fallbackFrom: null,
    });
  });

  it('idioma base: en-GB → en', () => {
    expect(resolveLocalizedText(both, 'en-GB')).toEqual({
      text: 'Come fasting.',
      language: 'en',
      fallbackFrom: null,
    });
  });

  it('exacto antes que base: es-419 con texto propio', () => {
    expect(
      resolveLocalizedText({ es: 'A', 'es-419': 'B' }, 'es-419'),
    ).toMatchObject({ text: 'B', language: 'es-419' });
  });

  it('paciente en inglés y texto solo en español → se envía el español', () => {
    expect(resolveLocalizedText({ es: 'Ven en ayunas.' }, 'en')).toEqual({
      text: 'Ven en ayunas.',
      language: 'es',
      fallbackFrom: 'en',
    });
  });

  it('sin preferencia (idioma de la clínica): español sin caída', () => {
    expect(resolveLocalizedText(both, null)).toEqual({
      text: 'Ven en ayunas.',
      language: 'es',
      fallbackFrom: null,
    });
  });

  it('sin español ni coincidencia → nada (no se manda un tercer idioma)', () => {
    expect(resolveLocalizedText({ en: 'Come fasting.' }, 'pt')).toBeNull();
    expect(resolveLocalizedText({ en: 'Come fasting.' }, null)).toBeNull();
  });

  it('mapa vacío o ausente → nada', () => {
    expect(resolveLocalizedText({}, 'es')).toBeNull();
    expect(resolveLocalizedText(null, 'es')).toBeNull();
    expect(resolveLocalizedText({ es: '' }, 'es')).toBeNull();
  });
});

describe('localizedTextEntries (DX-564)', () => {
  it('español primero, luego alfabético; sin vacías', () => {
    expect(
      localizedTextEntries({ pt: 'P', en: 'E', es: 'S', ca: 'C', fr: '' }),
    ).toEqual([
      { language: 'es', text: 'S' },
      { language: 'ca', text: 'C' },
      { language: 'en', text: 'E' },
      { language: 'pt', text: 'P' },
    ]);
  });
});

describe('localizedTextMapFromJson (DX-564)', () => {
  it('solo entradas de texto de un objeto', () => {
    expect(localizedTextMapFromJson({ es: 'A', en: 3, pt: '' })).toEqual({
      es: 'A',
    });
    expect(localizedTextMapFromJson(['es'])).toEqual({});
    expect(localizedTextMapFromJson(null)).toEqual({});
  });
});
