import {
  APPOINTMENT_TYPE_COLOR,
  appointmentTypeColorError,
  appointmentTypeDurationError,
  appointmentTypeNameError,
  endFromDuration,
  normalizeAppointmentTypeColor,
  normalizePreVisitInstructionText,
  PRE_VISIT_INSTRUCTIONS_LANGUAGE_NOT_OFFERED_MESSAGE,
  PRE_VISIT_INSTRUCTIONS_REPEATED_MESSAGE,
  preVisitInstructionLanguages,
  preVisitInstructionsFromEntries,
} from './appointment-type-rules';

describe('reglas de tipos de cita (DX-121)', () => {
  describe('color', () => {
    it.each(['#7C3AED', '#0e7490', '#000000', '#FFFFFF'])(
      'acepta %s',
      (color) => {
        expect(appointmentTypeColorError(color)).toBeNull();
        expect(APPOINTMENT_TYPE_COLOR.test(color)).toBe(true);
      },
    );

    it.each([
      '7C3AED',
      '#FFF',
      '#7C3AED80',
      'red',
      'url(javascript:alert(1))',
      '#7C3AED; background: url(x)',
      '#GGGGGG',
      ' #7C3AED',
    ])('rechaza %j (nunca CSS libre)', (color) => {
      expect(appointmentTypeColorError(color)).toMatch(/#RRGGBB/);
    });

    it('normaliza a mayúsculas', () => {
      expect(normalizeAppointmentTypeColor('#7c3aed')).toBe('#7C3AED');
    });
  });

  describe('duración', () => {
    it.each([5, 30, 90, 480])('acepta %i minutos', (minutes) => {
      expect(appointmentTypeDurationError(minutes)).toBeNull();
    });

    it.each([0, 4, 7, 481, 500, 30.5, -5, Number.NaN])(
      'rechaza %p minutos',
      (minutes) => {
        expect(appointmentTypeDurationError(minutes)).toMatch(/múltiplo de 5/);
      },
    );
  });

  describe('nombre', () => {
    it('rechaza vacío y más de 60 caracteres', () => {
      expect(appointmentTypeNameError('   ')).toMatch(/vacío/);
      expect(appointmentTypeNameError('x'.repeat(61))).toMatch(/60/);
      expect(appointmentTypeNameError('Endodoncia')).toBeNull();
    });
  });

  it('la hora de fin sale de la duración del tipo', () => {
    const start = new Date('2031-03-03T14:00:00.000Z');
    expect(endFromDuration(start, 90).toISOString()).toBe(
      '2031-03-03T15:30:00.000Z',
    );
  });
});

describe('indicaciones previas (DX-564)', () => {
  const ctx = { patientLanguages: ['es', 'en'], current: {} };
  const ok = (
    entries: { language: string; text: string }[],
    context: {
      patientLanguages: string[];
      current: Record<string, string>;
    } = ctx,
  ) => preVisitInstructionsFromEntries(entries, context);

  it('convierte la lista en el mapa, canoniza el idioma y recorta', () => {
    expect(
      ok([
        { language: 'ES', text: '  Ven en ayunas.\r\nTrae tus radiografías. ' },
        { language: 'en', text: 'Come fasting.' },
      ]),
    ).toEqual({
      map: {
        es: 'Ven en ayunas.\nTrae tus radiografías.',
        en: 'Come fasting.',
      },
    });
  });

  it('lista vacía = sin indicaciones; texto vacío tras recortar se descarta', () => {
    expect(ok([])).toEqual({ map: {} });
    expect(
      ok([
        { language: 'es', text: 'Ven en ayunas.' },
        { language: 'en', text: '  \n ' },
      ]),
    ).toEqual({ map: { es: 'Ven en ayunas.' } });
  });

  it('idioma repetido (también tras canonizar) → error', () => {
    expect(
      ok([
        { language: 'en', text: 'A' },
        { language: 'EN', text: 'B' },
      ]),
    ).toEqual({ error: PRE_VISIT_INSTRUCTIONS_REPEATED_MESSAGE });
  });

  it('idioma que no es BCP 47 → error', () => {
    expect(ok([{ language: 'inglés', text: 'A' }])).toEqual({
      error:
        'El idioma debe ser una etiqueta BCP 47 como «en», «ca» o «es-419».',
    });
  });

  it('idioma fuera de la lista de la clínica → error', () => {
    expect(ok([{ language: 'pt', text: 'Venha em jejum.' }])).toEqual({
      error:
        'Ese idioma no está entre los idiomas de los pacientes de la clínica.',
    });
  });

  it('un idioma ya retirado de la clínica se conserva si su texto no cambia', () => {
    const context = {
      patientLanguages: ['es'],
      current: { es: 'A', pt: 'Venha em jejum.' },
    };
    expect(
      ok(
        [
          { language: 'es', text: 'A' },
          { language: 'pt', text: 'Venha em jejum.' },
        ],
        context,
      ),
    ).toEqual({ map: { es: 'A', pt: 'Venha em jejum.' } });
    expect(ok([{ language: 'pt', text: 'Otro texto' }], context)).toEqual({
      error: PRE_VISIT_INSTRUCTIONS_LANGUAGE_NOT_OFFERED_MESSAGE,
    });
  });

  it('hasta 600 caracteres tras recortar', () => {
    expect(ok([{ language: 'es', text: ` ${'a'.repeat(600)} ` }])).toEqual({
      map: { es: 'a'.repeat(600) },
    });
    expect(ok([{ language: 'es', text: 'a'.repeat(601) }])).toEqual({
      error: 'Las indicaciones no pueden tener más de 600 caracteres.',
    });
  });

  it('el mapa entero no pasa de 8000 bytes (escrituras de 3 bytes por carácter)', () => {
    const langs = ['es', 'en', 'zh', 'ja', 'ko'];
    const context = { patientLanguages: langs, current: {} };
    // 5 × 600 caracteres de 3 bytes = 9000 bytes: cada texto vale, el conjunto no.
    expect(
      ok(
        langs.map((language) => ({ language, text: '歯'.repeat(600) })),
        context,
      ),
    ).toEqual({
      error:
        'Las indicaciones son demasiado largas en conjunto: acorta alguno de los idiomas.',
    });
    expect(
      ok(
        langs
          .slice(0, 4)
          .map((language) => ({ language, text: '歯'.repeat(600) })),
        context,
      ),
    ).toHaveProperty('map');
  });

  it('más de 10 idiomas → error', () => {
    expect(
      ok(
        Array.from({ length: 11 }, (_, i) => ({
          language: 'es',
          text: `${i}`,
        })),
      ),
    ).toEqual({ error: 'Las indicaciones admiten como mucho 10 idiomas.' });
  });

  it.each([
    'Lee https://example.com antes',
    'Mira http://example.com',
    'Entra en www.example.com',
    'Ven en <b>ayunas</b>',
    'Trae esto </p>',
    '<a href="x">aquí</a>',
    '<script>alert(1)</script>',
    '<!-- nota -->',
    'Ven <br/> en ayunas',
  ])('sin enlaces ni HTML: %j', (text) => {
    expect(ok([{ language: 'es', text }])).toEqual({
      error:
        'Las indicaciones no admiten enlaces ni HTML: escríbelas como texto.',
    });
  });

  it.each([
    'Ven 15 min antes: si la presión es < 140 o > 90 avisa',
    'Toma 1 comprimido 2 h antes (< 1 g).',
    'Escribe a recepción@clínica si tienes dudas',
  ])('admite texto corriente con signos: %j', (text) => {
    expect(ok([{ language: 'es', text }])).toEqual({ map: { es: text } });
  });

  it('quita caracteres de control salvo el salto de línea; tabulador = espacio', () => {
    expect(normalizePreVisitInstructionText('a\tb\u0000c \nd')).toBe('a bc\nd');
  });

  it('idiomas para la auditoría: español primero, luego alfabético', () => {
    expect(preVisitInstructionLanguages({ pt: 'x', es: 'y', en: 'z' })).toEqual(
      ['es', 'en', 'pt'],
    );
  });
});
