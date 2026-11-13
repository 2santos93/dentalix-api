import {
  canonicalLanguageTag,
  normalizePatientLanguages,
  resolveCatalogLanguage,
} from './patient-language';

describe('patient-language (DX-497)', () => {
  it.each([
    ['en', 'en'],
    ['EN', 'en'],
    [' ca ', 'ca'],
    ['pt_br', 'pt-BR'],
    ['zh-hant-tw', 'zh-Hant-TW'],
    ['es-419', 'es-419'],
  ])('canonicalLanguageTag(%j) = %j', (raw, tag) => {
    expect(canonicalLanguageTag(raw)).toBe(tag);
  });

  it.each(['', 'e', 'english', 'en-US-x-private', 'en US', '12'])(
    'rechaza %j',
    (raw) => {
      expect(canonicalLanguageTag(raw)).toBeNull();
    },
  );

  it('la lista siempre lleva el idioma de la clínica y no repite', () => {
    expect(normalizePatientLanguages(['en', 'EN', 'ca'])).toEqual([
      'es',
      'en',
      'ca',
    ]);
    expect(normalizePatientLanguages(['en', 'nope!'])).toBeNull();
  });

  describe('resolveCatalogLanguage', () => {
    const catalog = ['es', 'en'] as const;
    it('sin preferencia: el de la clínica, sin caída', () => {
      expect(resolveCatalogLanguage(null, catalog, 'es')).toEqual({
        language: 'es',
        fallbackFrom: null,
      });
    });
    it('con catálogo: el suyo', () => {
      expect(resolveCatalogLanguage('en', catalog, 'es')).toEqual({
        language: 'en',
        fallbackFrom: null,
      });
    });
    it('una variante regional usa el idioma base', () => {
      expect(resolveCatalogLanguage('en-GB', catalog, 'es')).toEqual({
        language: 'en',
        fallbackFrom: null,
      });
    });
    it('sin catálogo: el de la clínica, con la caída anotada (ca → es)', () => {
      expect(resolveCatalogLanguage('ca', catalog, 'es')).toEqual({
        language: 'es',
        fallbackFrom: 'ca',
      });
    });
  });
});
