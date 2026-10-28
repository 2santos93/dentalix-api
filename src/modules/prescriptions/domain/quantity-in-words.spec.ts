import { quantityInWords } from './quantity-in-words';

describe('quantityInWords (cantidad total en letras)', () => {
  it.each([
    [1, 'uno'],
    [7, 'siete'],
    [10, 'diez'],
    [15, 'quince'],
    [16, 'dieciséis'],
    [20, 'veinte'],
    [21, 'veintiuno'],
    [22, 'veintidós'],
    [23, 'veintitrés'],
    [26, 'veintiséis'],
    [30, 'treinta'],
    [31, 'treinta y uno'],
    [45, 'cuarenta y cinco'],
    [99, 'noventa y nueve'],
    [100, 'cien'],
    [101, 'ciento uno'],
    [120, 'ciento veinte'],
    [500, 'quinientos'],
    [555, 'quinientos cincuenta y cinco'],
    [700, 'setecientos'],
    [900, 'novecientos'],
    [1000, 'mil'],
    [1001, 'mil uno'],
    [1500, 'mil quinientos'],
    [2000, 'dos mil'],
    [9999, 'nueve mil novecientos noventa y nueve'],
  ])('%i → %s', (n, words) => {
    expect(quantityInWords(n)).toBe(words);
  });

  it.each([0, -1, 1.5, 10000, Number.NaN])('rechaza %p', (n) => {
    expect(() => quantityInWords(n)).toThrow(RangeError);
  });
});
