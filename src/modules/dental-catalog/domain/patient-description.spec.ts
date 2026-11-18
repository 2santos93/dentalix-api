import {
  PATIENT_DESCRIPTION_LANGUAGE_NOT_OFFERED_MESSAGE,
  PATIENT_DESCRIPTION_NO_LINKS_MESSAGE,
  PATIENT_DESCRIPTION_REPEATED_MESSAGE,
  PATIENT_DESCRIPTION_TOO_LARGE_MESSAGE,
  PATIENT_DESCRIPTION_TOO_LONG_MESSAGE,
  PATIENT_DESCRIPTION_TOO_MANY_MESSAGE,
  PATIENT_LABEL_FALLBACK,
  patientDescriptionEntries,
  patientDescriptionFromEntries,
  patientProcedureLabel,
  presentationLanguage,
} from './patient-description';

const LANGS = ['es', 'en', 'pt-BR', 'zh'];
const ctx = { patientLanguages: LANGS, current: {} };

describe('patientDescriptionFromEntries (DX-560)', () => {
  it('guarda el mapa normalizado y descarta los vacíos', () => {
    expect(
      patientDescriptionFromEntries(
        [
          { language: 'es', text: '  Limpieza profunda de las encías.  ' },
          { language: 'EN', text: '' },
        ],
        ctx,
      ),
    ).toEqual({ map: { es: 'Limpieza profunda de las encías.' } });
  });

  it('300 caracteres caben; 301 no', () => {
    const ok = 'a'.repeat(300);
    expect(
      patientDescriptionFromEntries([{ language: 'es', text: ok }], ctx),
    ).toEqual({ map: { es: ok } });
    expect(
      patientDescriptionFromEntries([{ language: 'es', text: `${ok}b` }], ctx),
    ).toEqual({ error: PATIENT_DESCRIPTION_TOO_LONG_MESSAGE });
  });

  it.each([
    'Más información en https://ejemplo.com',
    'Visita clinica.com.ve',
    'Escribe a citas@clinica.com',
    'Texto en <b>negrita</b>',
  ])('rechaza enlaces y HTML: %s', (text) => {
    expect(
      patientDescriptionFromEntries([{ language: 'es', text }], ctx),
    ).toEqual({ error: PATIENT_DESCRIPTION_NO_LINKS_MESSAGE });
  });

  it('solo idiomas de la clínica, sin repetir y hasta 10', () => {
    expect(
      patientDescriptionFromEntries([{ language: 'fr', text: 'x' }], ctx),
    ).toEqual({ error: PATIENT_DESCRIPTION_LANGUAGE_NOT_OFFERED_MESSAGE });
    expect(
      patientDescriptionFromEntries(
        [
          { language: 'es', text: 'x' },
          { language: 'es', text: 'y' },
        ],
        ctx,
      ),
    ).toEqual({ error: PATIENT_DESCRIPTION_REPEATED_MESSAGE });
    expect(
      patientDescriptionFromEntries(
        Array.from({ length: 11 }, () => ({ language: 'es', text: 'x' })),
        ctx,
      ),
    ).toEqual({ error: PATIENT_DESCRIPTION_TOO_MANY_MESSAGE });
  });

  it('el conjunto tiene tope en bytes (escrituras de 3 bytes)', () => {
    const ten = ['es', 'en', 'pt', 'fr', 'de', 'it', 'zh', 'ja', 'ko', 'ru'];
    expect(
      patientDescriptionFromEntries(
        ten.map((language) => ({ language, text: '牙'.repeat(299) })),
        { patientLanguages: ten, current: {} },
      ),
    ).toEqual({ error: PATIENT_DESCRIPTION_TOO_LARGE_MESSAGE });
  });

  it('la lista sale con el español primero y luego alfabética', () => {
    expect(patientDescriptionEntries({ pt: 'c', en: 'b', es: 'a' })).toEqual([
      { language: 'es', text: 'a' },
      { language: 'en', text: 'b' },
      { language: 'pt', text: 'c' },
    ]);
  });
});

describe('patientProcedureLabel (DX-560)', () => {
  const item = {
    labelEs: 'Tartrectomía',
    labelEn: 'Scaling',
    labelPt: null,
    patientDescription: {
      es: 'Limpieza profunda de las encías.',
      'pt-BR': 'Limpeza profunda das gengivas.',
    },
  };

  it('la descripción en el idioma exacto, si no en el base, si no en español', () => {
    expect(patientProcedureLabel(item, 'pt-BR')).toBe(
      'Limpeza profunda das gengivas.',
    );
    expect(patientProcedureLabel(item, 'en')).toBe(
      'Limpieza profunda de las encías.',
    );
    expect(
      patientProcedureLabel(
        { ...item, patientDescription: { en: 'Deep cleaning.' } },
        'en-GB',
      ),
    ).toBe('Deep cleaning.');
    expect(patientProcedureLabel(item, null)).toBe(
      'Limpieza profunda de las encías.',
    );
  });

  it('sin descripción: el nombre del catálogo en su idioma, si no labelEs', () => {
    const bare = { ...item, patientDescription: {} };
    expect(patientProcedureLabel(bare, 'en-US')).toBe('Scaling');
    expect(patientProcedureLabel(bare, 'pt')).toBe('Tartrectomía');
    expect(patientProcedureLabel(bare, 'es')).toBe('Tartrectomía');
    expect(patientProcedureLabel({ ...bare, labelEn: '  ' }, 'en')).toBe(
      'Tartrectomía',
    );
  });

  it('nunca un código ni un id: sin ítem, «Procedimiento»', () => {
    expect(patientProcedureLabel(null, 'es')).toBe(PATIENT_LABEL_FALLBACK);
    expect(PATIENT_LABEL_FALLBACK).toBe('Procedimiento');
  });

  it('el idioma de la presentación: el del paciente o es', () => {
    expect(presentationLanguage('en')).toBe('en');
    expect(presentationLanguage(null)).toBe('es');
  });
});
