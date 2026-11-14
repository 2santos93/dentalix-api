import {
  PREDEFINED_EXPENSE_CATEGORIES,
  categoryFilterName,
  categoryKey,
  matchLegacyPredefinedCategory,
  matchPredefinedCategory,
  normalizeCategoryName,
} from './expense-categories';
import { LEGACY_PREDEFINED_CATEGORY_KEYS } from './legacy-expense-categories';

/**
 * Los nombres anteriores salen de su único sitio (la guarda
 * `no-regional-expense-categories` no deja escribirlos en otro): aquí, con
 * otras mayúsculas y tildes, como llegarían de una URL guardada.
 */
const [OLD_RENT, OLD_CLEANING] = [...LEGACY_PREDEFINED_CATEGORY_KEYS.keys()];
const shout = (key: string) => `  ${key.toUpperCase().replace('A', 'Á')} `;

describe('categorías de gastos (DX-274, R3)', () => {
  it('las predefinidas son las de la spec, en orden, con términos neutros (DX-274-bis)', () => {
    expect(PREDEFINED_EXPENSE_CATEGORIES).toEqual([
      'Insumos clínicos',
      'Laboratorio',
      'Mensajería',
      'Limpieza y cafetería',
      'Papelería',
      'Servicios públicos',
      'Alquiler',
      'Mantenimiento',
      'Honorarios',
      'Impuestos y trámites',
      'Otros',
    ]);
  });

  it('normaliza espacios y compara sin mayúsculas ni tildes', () => {
    expect(normalizeCategoryName('  Limpieza   y  cafetería ')).toBe(
      'Limpieza y cafetería',
    );
    expect(categoryKey('LIMPIEZA Y CAFETERÍA')).toBe(
      categoryKey('limpieza y cafeteria'),
    );
  });

  it('reconoce una predefinida con otra grafía y devuelve la canónica', () => {
    expect(matchPredefinedCategory('insumos CLINICOS')).toBe(
      'Insumos clínicos',
    );
    expect(matchPredefinedCategory('  laboratorio ')).toBe('Laboratorio');
    expect(matchPredefinedCategory('Seguros')).toBeNull();
  });

  describe('nombres anteriores (DX-274-bis)', () => {
    it('son exactamente dos y cada uno lleva a una predefinida actual', () => {
      expect([...LEGACY_PREDEFINED_CATEGORY_KEYS.values()]).toEqual([
        'Alquiler',
        'Limpieza y cafetería',
      ]);
      for (const [key, name] of LEGACY_PREDEFINED_CATEGORY_KEYS) {
        expect(categoryKey(key)).toBe(key);
        expect(PREDEFINED_EXPENSE_CATEGORIES).toContain(name);
        expect(matchPredefinedCategory(key)).toBeNull();
      }
    });

    it('el nombre anterior, con cualquier grafía, es alias de la actual', () => {
      expect(matchLegacyPredefinedCategory(shout(OLD_RENT))).toBe('Alquiler');
      expect(matchLegacyPredefinedCategory(shout(OLD_CLEANING))).toBe(
        'Limpieza y cafetería',
      );
      expect(matchLegacyPredefinedCategory('Alquiler')).toBeNull();
      expect(matchLegacyPredefinedCategory('Seguros')).toBeNull();
    });

    it('el filtro da la grafía canónica (actual o por alias) y deja el resto tal cual', () => {
      expect(categoryFilterName(shout(OLD_RENT))).toBe('Alquiler');
      expect(categoryFilterName(shout(OLD_CLEANING))).toBe(
        'Limpieza y cafetería',
      );
      expect(categoryFilterName(' alquiler ')).toBe('Alquiler');
      expect(categoryFilterName('  Seguros   médicos ')).toBe(
        'Seguros médicos',
      );
    });
  });
});
