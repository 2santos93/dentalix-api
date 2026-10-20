import {
  normalizeTemplateCode,
  suggestTemplates,
  templateCodeError,
  textChanged,
} from './template-rules';

describe('templateCodeError', () => {
  it('acepta códigos válidos', () => {
    expect(templateCodeError('POI-EXO')).toBeNull();
    expect(templateCodeError('AB')).toBeNull();
  });

  it.each(['poi exo', 'poi-exo', 'A', '', 'A'.repeat(21), 'ÁB-1'])(
    'rechaza %p',
    (code) => {
      expect(templateCodeError(code)).toBe(
        'El código admite de 2 a 20 letras mayúsculas, números o guiones.',
      );
    },
  );
});

describe('normalizeTemplateCode', () => {
  it('recorta y pasa a mayúsculas', () => {
    expect(normalizeTemplateCode('  poi-exo ')).toBe('POI-EXO');
  });
});

describe('textChanged', () => {
  const before = { title: 'T', body: 'B' };
  it('es falso si no llega texto nuevo o es igual', () => {
    expect(textChanged(before, {})).toBe(false);
    expect(textChanged(before, { title: 'T', body: 'B' })).toBe(false);
  });
  it('es verdadero si cambia el título o el cuerpo', () => {
    expect(textChanged(before, { title: 'T2' })).toBe(true);
    expect(textChanged(before, { body: 'B2' })).toBe(true);
  });
});

describe('suggestTemplates', () => {
  const link = (
    catalogItemId: string | null,
    appointmentTypeId: string | null,
  ) => ({
    catalogItemId,
    appointmentTypeId,
  });
  const templates = [
    { id: 'a', active: true, links: [link(null, 'type-1')] },
    { id: 'b', active: true, links: [] },
    { id: 'c', active: false, links: [link('item-1', null)] },
    {
      id: 'd',
      active: true,
      links: [link('item-1', null), link('item-9', null)],
    },
    { id: 'e', active: true, links: [link('item-7', 'type-9')] },
  ];

  it('sugiere por tipo de cita y por ítem de catálogo, en orden estable', () => {
    expect(
      suggestTemplates({
        templates,
        appointmentTypeId: 'type-1',
        performedCatalogItemIds: ['item-1'],
      }),
    ).toEqual({ suggested: ['a', 'd'], others: ['b', 'e'] });
  });

  it('excluye las inactivas aunque coincidan', () => {
    const r = suggestTemplates({
      templates,
      appointmentTypeId: null,
      performedCatalogItemIds: ['item-1'],
    });
    expect([...r.suggested, ...r.others]).not.toContain('c');
    expect(r.suggested).toEqual(['d']);
  });

  it('sin coincidencias todo va a others', () => {
    expect(
      suggestTemplates({
        templates,
        appointmentTypeId: null,
        performedCatalogItemIds: [],
      }),
    ).toEqual({ suggested: [], others: ['a', 'b', 'd', 'e'] });
  });
});
