import {
  normalizePlanTemplate,
  planTemplateError,
  planTemplateNameKey,
  type PlanTemplateDraft,
} from './plan-template-rules';

const ITEM = '11111111-1111-4111-8111-111111111111';

function draft(overrides: Partial<PlanTemplateDraft> = {}): PlanTemplateDraft {
  return {
    name: 'Endodoncia + corona',
    visitIntervals: { '2': 7, '3': 14 },
    lines: [
      {
        catalogItemId: ITEM,
        quantity: 1,
        visit: 1,
        visitLabel: 'Apertura',
        asksSurfaces: false,
      },
      {
        catalogItemId: ITEM,
        quantity: 1,
        visit: 2,
        visitLabel: null,
        asksSurfaces: false,
      },
      {
        catalogItemId: ITEM,
        quantity: 2,
        visit: 3,
        visitLabel: null,
        asksSurfaces: true,
      },
    ],
    ...overrides,
  };
}

describe('reglas de la plantilla de plan (DX-559)', () => {
  it('una plantilla válida no tiene problemas', () => {
    expect(planTemplateError(draft())).toBeNull();
  });

  it('el nombre: no vacío, hasta 80 caracteres', () => {
    expect(planTemplateError(draft({ name: '   ' }))).toBe(
      'El nombre de la plantilla no puede estar vacío',
    );
    expect(planTemplateError(draft({ name: 'x'.repeat(81) }))).toMatch(
      /más de 80 caracteres/,
    );
    expect(planTemplateError(draft({ name: 'x'.repeat(80) }))).toBeNull();
  });

  it('de 1 a 50 líneas', () => {
    expect(planTemplateError(draft({ lines: [] }))).toBe(
      'La plantilla necesita al menos un procedimiento',
    );
    const line = draft().lines[0];
    expect(
      planTemplateError(
        draft({ lines: Array(51).fill(line), visitIntervals: {} }),
      ),
    ).toMatch(/como máximo 50/);
  });

  it('cantidad de 1 a 20 y visita de 1 a 50, enteras', () => {
    const base = draft().lines[0];
    for (const quantity of [0, 21, 1.5]) {
      expect(
        planTemplateError(
          draft({ lines: [{ ...base, quantity }], visitIntervals: {} }),
        ),
      ).toMatch(/cantidad de la línea 1/);
    }
    for (const visit of [0, 51, 2.5]) {
      expect(
        planTemplateError(
          draft({ lines: [{ ...base, visit }], visitIntervals: {} }),
        ),
      ).toMatch(/visita de la línea 1/);
    }
  });

  it('etiqueta de visita hasta 60 caracteres y la misma en toda la visita', () => {
    const base = draft().lines[0];
    expect(
      planTemplateError(
        draft({
          lines: [{ ...base, visitLabel: 'x'.repeat(61) }],
          visitIntervals: {},
        }),
      ),
    ).toMatch(/más de 60/);
    expect(
      planTemplateError(
        draft({
          lines: [base, { ...base, visitLabel: 'Otra' }],
          visitIntervals: {},
        }),
      ),
    ).toBe('Los procedimientos de la visita 1 deben tener la misma etiqueta');
    // «  Apertura » recortada es la misma etiqueta.
    expect(
      planTemplateError(
        draft({
          lines: [base, { ...base, visitLabel: '  Apertura ' }],
          visitIntervals: {},
        }),
      ),
    ).toBeNull();
  });

  it('los intervalos: claves de 2 a la última visita, días enteros de 0 a 3650', () => {
    expect(planTemplateError(draft({ visitIntervals: { '1': 3 } }))).toMatch(
      /de la visita 2 a la 3/,
    );
    expect(planTemplateError(draft({ visitIntervals: { '4': 3 } }))).toMatch(
      /de la visita 2 a la 3/,
    );
    expect(planTemplateError(draft({ visitIntervals: { '02': 3 } }))).toMatch(
      /de la visita 2/,
    );
    expect(planTemplateError(draft({ visitIntervals: { '2': -1 } }))).toMatch(
      /entre 0 y 3650/,
    );
    expect(planTemplateError(draft({ visitIntervals: { '2': 3651 } }))).toMatch(
      /entre 0 y 3650/,
    );
    expect(planTemplateError(draft({ visitIntervals: { '2': 0 } }))).toBeNull();
    const single = draft({
      lines: [draft().lines[0]],
      visitIntervals: { '2': 1 },
    });
    expect(planTemplateError(single)).toBe(
      'Una plantilla de una sola visita no lleva días entre visitas',
    );
  });

  it('normaliza: recorta, etiqueta vacía a null e id en minúsculas', () => {
    const out = normalizePlanTemplate(
      draft({
        name: '  Endodoncia  ',
        lines: [
          {
            catalogItemId: ITEM.toUpperCase(),
            quantity: 1,
            visit: 1,
            visitLabel: '   ',
            asksSurfaces: false,
          },
        ],
      }),
    );
    expect(out.name).toBe('Endodoncia');
    expect(out.lines[0]).toMatchObject({
      catalogItemId: ITEM,
      visitLabel: null,
    });
  });

  it('el nombre se compara sin mayúsculas ni espacios de más', () => {
    expect(planTemplateNameKey('  Endodoncia   +  Corona ')).toBe(
      planTemplateNameKey('endodoncia + corona'),
    );
  });
});
