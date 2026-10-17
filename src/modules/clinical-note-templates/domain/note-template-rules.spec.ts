import {
  answerText,
  composeNote,
  noteMarkers,
  noteTemplateError,
  normalizeNoteTemplate,
  SKIPPED_ANSWER,
  type NotePromptDraft,
  type NoteTemplateDraft,
} from './note-template-rules';

const surface: NotePromptDraft = {
  label: 'Superficie',
  type: 'ONE',
  options: ['O', 'M', 'D', 'V', 'L'],
  defaultValue: null,
};
const material: NotePromptDraft = {
  label: 'Material',
  type: 'MULTI',
  options: ['Resina A2', 'Ionómero', 'Adhesivo universal'],
  defaultValue: 'Resina A2',
};
const remarks: NotePromptDraft = {
  label: 'Observaciones',
  type: 'TEXT',
  options: [],
  defaultValue: null,
};

function resin(overrides: Partial<NoteTemplateDraft> = {}): NoteTemplateDraft {
  return {
    name: 'Resina',
    category: 'Operatoria',
    body: 'Resina en superficie {{Superficie}} con {{Material}}. {{Observaciones}}',
    prompts: [surface, material, remarks],
    ...overrides,
  };
}

describe('plantillas de evolución: reglas (DX-170)', () => {
  describe('marcadores', () => {
    it('lee los marcadores {{…}} del cuerpo, recortados', () => {
      expect(
        noteMarkers('A {{ Superficie }} y {{Material}} y {{Superficie}}'),
      ).toEqual(['Superficie', 'Material', 'Superficie']);
    });

    it('no confunde llaves sueltas con marcadores', () => {
      expect(noteMarkers('Llave { sola } y {{Material')).toEqual([]);
    });
  });

  describe('validación de la plantilla', () => {
    it('acepta la plantilla «Resina» con preguntas ONE, MULTI y TEXT', () => {
      expect(noteTemplateError(resin())).toBeNull();
    });

    it('el marcador casa con la etiqueta sin importar mayúsculas ni espacios', () => {
      expect(
        noteTemplateError(
          resin({ body: '{{superficie}} {{ MATERIAL }} {{Observaciones}}' }),
        ),
      ).toBeNull();
    });

    it.each<[string, Partial<NoteTemplateDraft>, RegExp]>([
      ['nombre vacío', { name: '  ' }, /nombre.*vacío/],
      ['nombre largo', { name: 'x'.repeat(81) }, /80 caracteres/],
      ['carpeta larga', { category: 'x'.repeat(61) }, /60 caracteres/],
      ['cuerpo vacío', { body: ' ' }, /texto de la plantilla.*vacío/],
      [
        'cuerpo largo',
        {
          body: `{{Superficie}}{{Material}}{{Observaciones}}${'x'.repeat(5000)}`,
        },
        /5000/,
      ],
      [
        'marcador sin pregunta',
        { body: '{{Superficie}} {{Material}} {{Observaciones}} {{Diente}}' },
        /El marcador \{\{Diente\}\} no corresponde a ninguna pregunta/,
      ],
      [
        'marcador vacío',
        { body: '{{Superficie}} {{Material}} {{Observaciones}} {{ }}' },
        /marcador vacío/,
      ],
      [
        'pregunta sin marcador',
        { body: '{{Superficie}} {{Material}}' },
        /La pregunta «Observaciones» no aparece en el texto/,
      ],
      [
        'ONE sin opciones',
        { prompts: [{ ...surface, options: [] }, material, remarks] },
        /«Superficie» es de opción única y necesita al menos una opción/,
      ],
      [
        'MULTI sin opciones',
        {
          prompts: [
            surface,
            { ...material, options: ['  '], defaultValue: null },
            remarks,
          ],
        },
        /«Material» es de opción múltiple y necesita al menos una opción/,
      ],
      [
        'TEXT con opciones',
        { prompts: [surface, material, { ...remarks, options: ['x'] }] },
        /texto libre y no lleva opciones/,
      ],
      [
        'etiqueta de más de 50',
        { prompts: [surface, material, { ...remarks, label: 'x'.repeat(51) }] },
        /50 caracteres/,
      ],
      [
        'etiqueta con llaves',
        { prompts: [surface, material, { ...remarks, label: 'Obs {x}' }] },
        /llaves/,
      ],
      [
        'etiquetas repetidas',
        {
          prompts: [
            surface,
            { ...surface, label: ' superficie ' },
            material,
            remarks,
          ],
        },
        /dos preguntas con la etiqueta «superficie»/i,
      ],
      [
        'opciones repetidas',
        { prompts: [{ ...surface, options: ['O', 'o'] }, material, remarks] },
        /opción «o» está repetida/i,
      ],
      [
        'por defecto fuera de las opciones',
        { prompts: [{ ...surface, defaultValue: 'X' }, material, remarks] },
        /valor por defecto de «Superficie» tiene que ser una de sus opciones/,
      ],
      [
        'demasiadas preguntas',
        {
          body: Array.from({ length: 21 }, (_, i) => `{{P${i}}}`).join(' '),
          prompts: Array.from({ length: 21 }, (_, i) => ({
            ...remarks,
            label: `P${i}`,
          })),
        },
        /20 preguntas/,
      ],
    ])('rechaza %s', (_label, override, message) => {
      expect(noteTemplateError(resin(override))).toMatch(message);
    });

    it('normaliza: recorta textos, carpeta vacía a null y quita el valor por defecto vacío', () => {
      expect(
        normalizeNoteTemplate(
          resin({
            name: '  Resina ',
            category: '  ',
            prompts: [
              {
                ...surface,
                label: ' Superficie ',
                options: [' O ', 'M'],
                defaultValue: ' ',
              },
              material,
              remarks,
            ],
          }),
        ),
      ).toMatchObject({
        name: 'Resina',
        category: null,
        prompts: [
          { label: 'Superficie', options: ['O', 'M'], defaultValue: null },
          {},
          {},
        ],
      });
    });
  });

  describe('respuesta de una pregunta', () => {
    it('ONE: la opción elegida', () => {
      expect(answerText(surface, { values: ['O'] })).toEqual({ text: 'O' });
    });

    it('MULTI: en el orden de las opciones, con «y» antes de la última', () => {
      expect(
        answerText(material, {
          values: ['Adhesivo universal', 'Resina A2', 'Ionómero'],
        }),
      ).toEqual({ text: 'Resina A2, Ionómero y Adhesivo universal' });
      expect(answerText(material, { values: ['Ionómero'] })).toEqual({
        text: 'Ionómero',
      });
    });

    it('TEXT: el texto recortado, sin caracteres de control', () => {
      expect(
        answerText(remarks, { values: ['  Sin\u0007 sensibilidad.\n '] }),
      ).toEqual({
        text: 'Sin sensibilidad.',
      });
    });

    it('sin respuesta: el valor por defecto; si no tiene, el hueco marcado', () => {
      expect(answerText(material, undefined)).toEqual({ text: 'Resina A2' });
      expect(answerText(surface, undefined)).toEqual({ text: SKIPPED_ANSWER });
    });

    it('«Omitir» o una respuesta vacía dejan el hueco marcado aunque haya valor por defecto', () => {
      expect(SKIPPED_ANSWER).toBe('[sin respuesta]');
      expect(answerText(material, { skipped: true })).toEqual({
        text: SKIPPED_ANSWER,
      });
      expect(answerText(material, { values: [] })).toEqual({
        text: SKIPPED_ANSWER,
      });
      expect(answerText(remarks, { values: ['   '] })).toEqual({
        text: SKIPPED_ANSWER,
      });
    });

    it.each<[NotePromptDraft, string[], RegExp]>([
      [surface, ['X'], /«X» no es una opción de «Superficie»/],
      [surface, ['O', 'M'], /«Superficie» admite una sola opción/],
      [material, ['Amalgama'], /«Amalgama» no es una opción de «Material»/],
      [remarks, ['a', 'b'], /«Observaciones» admite un solo texto/],
      [remarks, ['x'.repeat(1001)], /1000 caracteres/],
    ])('rechaza respuestas inválidas (%#)', (prompt, values, message) => {
      const result = answerText(prompt, { values });
      expect('error' in result && result.error).toMatch(message);
    });
  });

  describe('composición del texto', () => {
    it('sustituye cada marcador por su respuesta (también los repetidos)', () => {
      expect(
        composeNote(
          '{{Superficie}}: {{Material}}. Otra vez {{ superficie }}.',
          [
            { label: 'Superficie', text: 'O' },
            { label: 'Material', text: 'Resina A2' },
          ],
        ),
      ).toBe('O: Resina A2. Otra vez O.');
    });

    it('escapa: una respuesta con marcadores o patrones de reemplazo se copia literal', () => {
      expect(
        composeNote('Material: {{Material}}. Superficie: {{Superficie}}.', [
          { label: 'Material', text: '{{Superficie}} $& $1 <b>' },
          { label: 'Superficie', text: 'O' },
        ]),
      ).toBe('Material: {{Superficie}} $& $1 <b>. Superficie: O.');
    });

    it('un marcador sin respuesta queda marcado «[sin respuesta]»', () => {
      expect(composeNote('Dolor: {{Dolor}}', [])).toBe(
        'Dolor: [sin respuesta]',
      );
    });
  });
});
