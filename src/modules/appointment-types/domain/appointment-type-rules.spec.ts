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

describe('indicaciones previas: enlaces sin http, formato invisible y líneas en blanco (DX-564, revisión)', () => {
  const ctx = { patientLanguages: ['es'], current: {} };
  const check = (text: string) =>
    preVisitInstructionsFromEntries([{ language: 'es', text }], ctx);
  const NO_LINKS =
    'Las indicaciones no admiten enlaces ni HTML: escríbelas como texto.';
  const ch = (code: number) => String.fromCharCode(code);

  it.each([
    'Entra en ejemplo.com/login',
    'Mira bit.ly',
    'Más en ejemplo.com.ve, gracias',
    'Escribe a recepcion@ejemplo.com',
    'Correo: x@evil.com.',
    // Sin distinguir mayúsculas, etiqueta de una letra e IPv4.
    'Entra en EJEMPLO.COM',
    'Entra en Ejemplo.Com/login',
    'Síguenos en x.com',
    'Abre 192.168.0.1/login',
    'Abre 10.0.0.1',
    'Tienda: tienda.com.VE.',
    'Puerto: ejemplo.io:8080',
  ])('rechaza dominios y emails sin http: %j', (text) => {
    expect(check(text)).toEqual({ error: NO_LINKS });
  });

  it.each([
    'Ven en ayunas de 6h.Trae tus radiografías.',
    'Te atiende el Dr.Pérez.',
    'Llega a las 10.30 h.',
    'Ven a las 9 a.m. en punto.',
    'Trae, p.ej. tus radiografías.',
    'Te atiende el Sr.García.',
    'Toma 1.5 ml del jarabe.',
    'Llega a las 10.30 h y trae 2.5 cm de gasa.',
    'Ven a las 9 p.m.',
    'Si la presión es < 140 avísanos.',
  ])('no marca texto corriente: %j', (text) => {
    expect(check(text)).toEqual({ map: { es: text } });
  });

  it.each([
    ['espacio de ancho cero', 0x200b],
    ['guion suave', 0xad],
    ['inversión de dirección (U+202E)', 0x202e],
  ])('quita %s y detecta el dominio que partía', (_label, code) => {
    expect(check(`Entra en ejemplo${ch(code)}.com`)).toEqual({
      error: NO_LINKS,
    });
    expect(normalizePreVisitInstructionText(`Ven${ch(code)} en ayunas`)).toBe(
      'Ven en ayunas',
    );
  });

  it('conserva U+200D (emojis compuestos)', () => {
    const family = `${ch(0xd83d)}${ch(0xdc68)}${ch(0x200d)}${ch(0xd83d)}${ch(0xdc67)}`;
    expect(normalizePreVisitInstructionText(`Ven ${family}`)).toBe(
      `Ven ${family}`,
    );
  });

  it('3 o más saltos seguidos quedan en 2 (también con espacios en medio)', () => {
    expect(normalizePreVisitInstructionText('A\n\n\n\n\nB')).toBe('A\n\nB');
    expect(normalizePreVisitInstructionText('A \n \n  \nB\n\nC')).toBe(
      'A\n\nB\n\nC',
    );
    expect(check(`A${'\n'.repeat(600)}B`)).toEqual({ map: { es: 'A\n\nB' } });
  });
});

describe('falso positivo aceptado del filtro de enlaces (DX-564)', () => {
  it('«ayunas.No coma» se marca (.no es TLD); con un espacio pasa', () => {
    const ctx = { patientLanguages: ['es'], current: {} };
    expect(
      preVisitInstructionsFromEntries(
        [{ language: 'es', text: 'Ven en ayunas.No comas nada.' }],
        ctx,
      ),
    ).toHaveProperty('error');
    expect(
      preVisitInstructionsFromEntries(
        [{ language: 'es', text: 'Ven en ayunas. No comas nada.' }],
        ctx,
      ),
    ).toHaveProperty('map');
  });
});
