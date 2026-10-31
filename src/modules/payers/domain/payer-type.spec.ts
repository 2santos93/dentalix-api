import {
  PAYER_TYPES,
  isExternalPayer,
  isPayerType,
  type PayerType,
} from './payer-type';

describe('payer-type', () => {
  it('PAYER_TYPES lists the five generic types in order', () => {
    expect([...PAYER_TYPES]).toEqual([
      'INSURER',
      'PREPAID_PLAN',
      'PUBLIC_SYSTEM',
      'EMPLOYER',
      'OTHER',
    ]);
  });

  it.each(PAYER_TYPES)(
    'isExternalPayer: every type but OTHER is external (%s)',
    (type) => {
      expect(isExternalPayer(type)).toBe(type !== 'OTHER');
    },
  );

  it.each(['', undefined, 'constructor', 'toString', '__proto__'])(
    'isExternalPayer throws on a value outside the five (%p)',
    (value) => {
      expect(() => isExternalPayer(value as unknown as PayerType)).toThrow(
        `Tipo de pagador desconocido: ${String(value)}`,
      );
    },
  );

  it.each(['OTRO', 'PUBLIC'])(
    'other codes are not domain types: isExternalPayer throws (%s)',
    (code) => {
      expect(() => isExternalPayer(code as unknown as PayerType)).toThrow(code);
    },
  );

  it('isPayerType accepts the five and nothing else', () => {
    for (const type of PAYER_TYPES) expect(isPayerType(type)).toBe(true);
    for (const value of ['constructor', '__proto__', 'OTRO', '', null, 3]) {
      expect(isPayerType(value)).toBe(false);
    }
  });
});
