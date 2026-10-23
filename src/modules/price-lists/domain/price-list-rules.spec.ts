import {
  duplicatedCatalogItemIds,
  normalizePriceListName,
  priceListNameKey,
  PRICE_LIST_NAME_MAX,
  PRICE_LIST_NAME_MESSAGE,
  validatePriceListName,
} from './price-list-rules';

describe('price-list-rules (DX-105)', () => {
  describe('normalizePriceListName / priceListNameKey', () => {
    it('recorta los extremos y colapsa los espacios internos', () => {
      expect(normalizePriceListName('  Sede   Norte  ')).toBe('Sede Norte');
    });

    it('la clave ignora mayúsculas y tildes', () => {
      expect(priceListNameKey('  LISTA  Convenio Bolívar ')).toBe(
        priceListNameKey('lista convenio bolivar'),
      );
    });
  });

  describe('validatePriceListName', () => {
    it.each([
      ['de 2 caracteres', 'ab', null],
      ['de 1 carácter', 'a', PRICE_LIST_NAME_MESSAGE],
      ['solo espacios', '   ', PRICE_LIST_NAME_MESSAGE],
      ['con espacios que dejan 1', ' a ', PRICE_LIST_NAME_MESSAGE],
      ['de 120', 'x'.repeat(PRICE_LIST_NAME_MAX), null],
      ['de 121', 'x'.repeat(PRICE_LIST_NAME_MAX + 1), PRICE_LIST_NAME_MESSAGE],
    ])('un nombre %s', (_label, name, expected) => {
      expect(validatePriceListName(name)).toBe(expected);
    });
  });

  describe('duplicatedCatalogItemIds', () => {
    it('sin repetidos devuelve vacío', () => {
      expect(duplicatedCatalogItemIds(['a', 'b'])).toEqual([]);
    });

    it('devuelve cada id repetido una sola vez', () => {
      expect(duplicatedCatalogItemIds(['a', 'b', 'a', 'a', 'b', 'c'])).toEqual([
        'a',
        'b',
      ]);
    });
  });
});
