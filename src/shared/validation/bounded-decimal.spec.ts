import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
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
