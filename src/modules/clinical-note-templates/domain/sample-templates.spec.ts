import { noteTemplateError } from './note-template-rules';
import { SAMPLE_NOTE_TEMPLATES } from './sample-templates';

describe('plantillas de ejemplo (DX-170)', () => {
  it('son las 6 pedidas, con nombres distintos', () => {
    expect(SAMPLE_NOTE_TEMPLATES.map((t) => t.name)).toEqual([
      'Exploración / control',
      'Profilaxis',
      'Resina',
      'Exodoncia simple',
      'Endodoncia por sesión',
      'Control postoperatorio',
    ]);
  });

  it.each(SAMPLE_NOTE_TEMPLATES.map((t) => [t.name, t] as const))(
    '«%s» cumple las reglas de la API',
    (_name, template) => {
      expect(noteTemplateError(template)).toBeNull();
    },
  );
});
