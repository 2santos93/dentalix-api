import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IsOptional } from 'class-validator';
import {
  IsBoundedDecimal,
  IsNonNegativeMoney,
  IsPositiveMoney,
  IsMoney,
  IsQuantity,
  MONEY_MAX,
  QUANTITY_MAX,
  decimalPlaces,
} from './bounded-decimal';

class MoneyHolder {
  @IsMoney()
  amount!: number;
}

class QuantityHolder {
  @IsQuantity()
  quantity!: number;
}

async function errorsFor<T extends object>(
  cls: new () => T,
  body: Record<string, unknown>,
): Promise<number> {
  return (await validate(plainToInstance(cls, body))).length;
}

describe('decimalPlaces', () => {
  it.each([
    [10, 0],
    [10.5, 1],
    [10.05, 2],
    [10.005, 3],
    [0.29, 2],
    [9_999_999_999.99, 2],
    [1e-7, 7],
    [1.5e-7, 8],
    [-3.25, 2],
  ])('%p tiene %p decimales', (value, expected) => {
    expect(decimalPlaces(value)).toBe(expected);
  });
});

describe('IsMoney (DX-042)', () => {
  it.each([0.01, 100, 10.5, 1234.56, MONEY_MAX])(
    'acepta %p',
    async (amount) => {
      expect(await errorsFor(MoneyHolder, { amount })).toBe(0);
    },
  );

  it.each([
    ['3 decimales', 10.005],
    ['un valor diminuto en notación exponencial', 1e-7],
    ['13 dígitos enteros', 1_234_567_890_123],
    ['justo por encima del máximo', 10_000_000_000],
    ['Infinity', Infinity],
    ['NaN', NaN],
    ['un string', '10'],
  ])('rechaza %s', async (_label, amount) => {
    expect(await errorsFor(MoneyHolder, { amount })).toBe(1);
  });
});

describe('IsQuantity (DX-042)', () => {
  it.each([1, 12.5, 0.125, -2.5, QUANTITY_MAX, -QUANTITY_MAX])(
    'acepta %p',
    async (quantity) => {
      expect(await errorsFor(QuantityHolder, { quantity })).toBe(0);
    },
  );

  it.each([0.0001, 10_000_000_000, -10_000_000_000])(
    'rechaza %p',
    async (quantity) => {
      expect(await errorsFor(QuantityHolder, { quantity })).toBe(1);
    },
  );
});

/** Los mensajes de `field` al validar `body` en `cls`. */
async function messagesFor<T extends object>(
  cls: new () => T,
  body: Record<string, unknown>,
  field: string,
): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, body));
  return Object.values(
    errors.find((e) => e.property === field)?.constraints ?? {},
  );
}

class PositiveHolder {
  @IsPositiveMoney()
  amount!: number;
}

class NonNegativeHolder {
  @IsOptional()
  @IsNonNegativeMoney()
  amount?: number;
}

class NamedNonNegativeHolder {
  @IsNonNegativeMoney('MENSAJE PROPIO')
  amount!: number;
}

class RateHolder {
  @IsBoundedDecimal({ maxDecimals: 8, maxAbs: 9_999_999.99999999 })
  rate!: number;
}

// DX-517-quater: ningún importe responde en inglés por defecto.
describe('mensajes por defecto en español (DX-517-quater)', () => {
  const MONEY_TEXT =
    'El importe tiene que ser un número con hasta 2 decimales y no mayor que 9.999.999.999,99.';

  it('IsMoney: demasiados decimales y por encima del máximo, con el máximo formateado', async () => {
    expect(
      await messagesFor(MoneyHolder, { amount: 10.005 }, 'amount'),
    ).toEqual([MONEY_TEXT]);
    expect(
      await messagesFor(MoneyHolder, { amount: 10_000_000_000 }, 'amount'),
    ).toEqual([MONEY_TEXT]);
  });

  it('IsBoundedDecimal sin mensaje: texto genérico con sus propios límites', async () => {
    expect(
      await messagesFor(RateHolder, { rate: 1.123456789 }, 'rate'),
    ).toEqual([
      'El valor tiene que ser un número con hasta 8 decimales y no mayor que 9.999.999,99999999.',
    ]);
  });

  it('IsPositiveMoney: no número, 0, negativo, 3 decimales y sobre el máximo', async () => {
    const positive = 'El importe tiene que ser un número mayor que 0.';
    expect(
      await messagesFor(PositiveHolder, { amount: '5' }, 'amount'),
    ).toContain(positive);
    expect(await messagesFor(PositiveHolder, { amount: 0 }, 'amount')).toEqual([
      positive,
    ]);
    expect(await messagesFor(PositiveHolder, { amount: -1 }, 'amount')).toEqual(
      [positive],
    );
    expect(
      await messagesFor(PositiveHolder, { amount: 1.005 }, 'amount'),
    ).toEqual([MONEY_TEXT]);
    expect(
      await messagesFor(PositiveHolder, { amount: 1e10 }, 'amount'),
    ).toEqual([MONEY_TEXT]);
  });

  it('IsNonNegativeMoney: negativo, no número y 3 decimales; el mensaje de signo se puede cambiar', async () => {
    const nonNegative =
      'El importe tiene que ser un número mayor o igual que 0.';
    expect(
      await messagesFor(NonNegativeHolder, { amount: -1 }, 'amount'),
    ).toEqual([nonNegative]);
    expect(
      await messagesFor(NonNegativeHolder, { amount: 'x' }, 'amount'),
    ).toContain(nonNegative);
    expect(
      await messagesFor(NonNegativeHolder, { amount: 1.005 }, 'amount'),
    ).toEqual([MONEY_TEXT]);
    expect(await messagesFor(NonNegativeHolder, {}, 'amount')).toEqual([]);
    expect(
      await messagesFor(NamedNonNegativeHolder, { amount: -1 }, 'amount'),
    ).toEqual(['MENSAJE PROPIO']);
  });
});
