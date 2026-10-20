import { SAMPLE_POSTOP_TEMPLATES } from './sample-templates';
import { unknownVariables } from './render-instructions';
import { templateCodeError } from './template-rules';

const CLOSING =
  'Si tienes dolor intenso que no cede, sangrado que no para o fiebre, llama a {{clinica}} al {{telefono_sede}} en horario de atención. Fuera de horario, acude al servicio de urgencias más cercano.';

describe('SAMPLE_POSTOP_TEMPLATES', () => {
  it('trae los cinco códigos esperados', () => {
    expect(SAMPLE_POSTOP_TEMPLATES.map((t) => t.code)).toEqual([
      'POI-EXO',
      'POI-CORDAL',
      'POI-ENDO',
      'POI-IMPLANTE',
      'POI-PROTESIS',
    ]);
  });

  it('los códigos son válidos y únicos', () => {
    const codes = SAMPLE_POSTOP_TEMPLATES.map((t) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(templateCodeError(code)).toBeNull();
  });

  describe.each(SAMPLE_POSTOP_TEMPLATES.map((t) => [t.code, t] as const))(
    '%s',
    (_c, t) => {
      it('solo usa variables conocidas y cabe en el límite', () => {
        expect(unknownVariables(t.body)).toEqual([]);
        expect(t.body.length).toBeLessThanOrEqual(20000);
        expect(t.title.length).toBeGreaterThan(0);
      });

      it('usa paciente, clínica y teléfono de la sede', () => {
        expect(t.body).toContain('{{paciente}}');
        expect(t.body).toContain('{{clinica}}');
        expect(t.body).toContain('{{telefono_sede}}');
      });

      it('termina con el párrafo de urgencia exacto', () => {
        expect(t.body.endsWith(CLOSING)).toBe(true);
      });
    },
  );
});
