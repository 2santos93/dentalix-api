import {
  PREDEFINED_EXPENSE_CATEGORIES,
  categoryKey,
  matchPredefinedCategory,
  normalizeCategoryName,
} from './expense-categories';

describe('categorías de gastos (DX-274, R3)', () => {
  it('las predefinidas son las de la spec, en orden', () => {
    expect(PREDEFINED_EXPENSE_CATEGORIES).toEqual([
      'Insumos clínicos',
      'Laboratorio',
      'Mensajería',
      'Aseo y cafetería',
      'Papelería',
      'Servicios públicos',
      'Arriendo',
      'Mantenimiento',
      'Honorarios',
      'Impuestos y trámites',
      'Otros',
    ]);
  });

  it('normaliza espacios y compara sin mayúsculas ni tildes', () => {
    expect(normalizeCategoryName('  Aseo   y  cafetería ')).toBe(
      'Aseo y cafetería',
    );
    expect(categoryKey('ASEO Y CAFETERÍA')).toBe(
      categoryKey('aseo y cafeteria'),
    );
  });

  it('reconoce una predefinida con otra grafía y devuelve la canónica', () => {
    expect(matchPredefinedCategory('insumos CLINICOS')).toBe(
      'Insumos clínicos',
    );
    expect(matchPredefinedCategory('  laboratorio ')).toBe('Laboratorio');
    expect(matchPredefinedCategory('Seguros')).toBeNull();
  });
});
