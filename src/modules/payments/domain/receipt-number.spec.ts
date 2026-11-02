import { formatReceiptNumber, legacyReceiptReference } from './receipt-number';

describe('número de recibo (DX-136)', () => {
  it('serie de la sede, guion y el número con 6 cifras', () => {
    expect(formatReceiptNumber('CCS', 123)).toBe('CCS-000123');
    expect(formatReceiptNumber('NOR', 1)).toBe('NOR-000001');
  });

  it('pasado el millón no se recorta: crece', () => {
    expect(formatReceiptNumber('CCS', 1234567)).toBe('CCS-1234567');
  });

  it('rechaza un número que no es un entero positivo', () => {
    expect(() => formatReceiptNumber('CCS', 0)).toThrow(RangeError);
    expect(() => formatReceiptNumber('CCS', -4)).toThrow(RangeError);
    expect(() => formatReceiptNumber('CCS', 1.5)).toThrow(RangeError);
  });

  it('rechaza una serie con otro formato', () => {
    expect(() => formatReceiptNumber('ccs', 1)).toThrow(RangeError);
    expect(() => formatReceiptNumber('', 1)).toThrow(RangeError);
  });

  it('la referencia antigua (sin serie) es REC- y los 8 primeros del id', () => {
    expect(legacyReceiptReference('3f1c2b9e-8a4d-4c1e-9f0a-1b2c3d4e5f60')).toBe(
      'REC-3f1c2b9e',
    );
  });
});
