import { CatalogKind } from '@prisma/client';
import { DEFAULT_DENTAL_CATALOG } from './default-dental-catalog';
import { HEX_COLOR_PATTERN } from '../../modules/dental-catalog/application/use-cases/create-catalog-item.use-case';

describe('DEFAULT_DENTAL_CATALOG', () => {
  it('is non-empty', () => {
    expect(DEFAULT_DENTAL_CATALOG.length).toBeGreaterThan(0);
  });

  it('has unique codes', () => {
    const codes = DEFAULT_DENTAL_CATALOG.map((i) => i.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('every color is a valid hex accepted by the create use-case', () => {
    for (const item of DEFAULT_DENTAL_CATALOG) {
      expect(HEX_COLOR_PATTERN.test(item.color)).toBe(true);
    }
  });

  it('every item has a valid kind', () => {
    const valid = new Set<CatalogKind>([
      CatalogKind.DIAGNOSIS,
      CatalogKind.PROCEDURE,
    ]);
    for (const item of DEFAULT_DENTAL_CATALOG) {
      expect(valid.has(item.kind)).toBe(true);
    }
  });

  it('every item has non-blank code, category and labels in the 3 languages', () => {
    for (const item of DEFAULT_DENTAL_CATALOG) {
      expect(item.code.trim()).not.toBe('');
      expect(item.category.trim()).not.toBe('');
      expect(item.labelEs.trim()).not.toBe('');
      expect(item.labelEn.trim()).not.toBe('');
      expect(item.labelPt.trim()).not.toBe('');
    }
  });
});
