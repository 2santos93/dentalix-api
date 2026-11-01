import type { PrismaService } from '../prisma/prisma.service';
import {
  CURRENCY_DIGITS_TTL_MS,
  PrismaCurrencyDigitsCatalog,
} from './prisma-currency-digits.catalog';

function prismaWith(
  rows: { code: string; minorUnits: number; roundingDigits: number }[],
) {
  const findMany = jest.fn(() => Promise.resolve(rows.map((r) => ({ ...r }))));
  return {
    prisma: { currency: { findMany } } as unknown as PrismaService,
    findMany,
    rows,
  };
}

describe('PrismaCurrencyDigitsCatalog (DX-340)', () => {
  beforeEach(() =>
    jest.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z') }),
  );
  afterEach(() => jest.useRealTimers());

  it('lee la tabla una vez y la reutiliza dentro del plazo', async () => {
    const { prisma, findMany } = prismaWith([
      { code: 'RSD', minorUnits: 2, roundingDigits: 0 },
    ]);
    const catalog = new PrismaCurrencyDigitsCatalog(prisma);
    await catalog.table(['RSD']);
    await catalog.table(['RSD']);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('pasado el plazo vuelve a leer: un cambio de rounding_digits llega sin reiniciar', async () => {
    const { prisma, findMany, rows } = prismaWith([
      { code: 'RSD', minorUnits: 2, roundingDigits: 0 },
    ]);
    const catalog = new PrismaCurrencyDigitsCatalog(prisma);
    expect((await catalog.table(['RSD'])).roundingDigits('RSD')).toBe(0);
    rows[0].roundingDigits = 2;
    jest.setSystemTime(Date.now() + CURRENCY_DIGITS_TTL_MS - 1);
    expect((await catalog.table(['RSD'])).roundingDigits('RSD')).toBe(0);
    jest.setSystemTime(Date.now() + 2);
    expect((await catalog.table(['RSD'])).roundingDigits('RSD')).toBe(2);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('una moneda que no estaba se relee al momento; si sigue sin estar, error', async () => {
    const { prisma, findMany, rows } = prismaWith([
      { code: 'EUR', minorUnits: 2, roundingDigits: 2 },
    ]);
    const catalog = new PrismaCurrencyDigitsCatalog(prisma);
    await catalog.table(['EUR']);
    rows.push({ code: 'JPY', minorUnits: 0, roundingDigits: 0 });
    expect((await catalog.table(['JPY'])).roundingDigits('JPY')).toBe(0);
    expect(findMany).toHaveBeenCalledTimes(2);
    const table = await catalog.table(['ZZZ']);
    expect(() => table.of('ZZZ')).toThrow(/sin decimales en el catálogo/);
  });

  it('un fallo de lectura no se queda en caché', async () => {
    const findMany = jest
      .fn()
      .mockRejectedValueOnce(new Error('caída'))
      .mockResolvedValueOnce([
        { code: 'EUR', minorUnits: 2, roundingDigits: 2 },
      ]);
    const catalog = new PrismaCurrencyDigitsCatalog({
      currency: { findMany },
    } as unknown as PrismaService);
    await expect(catalog.table()).rejects.toThrow('caída');
    expect((await catalog.table(['EUR'])).roundingDigits('EUR')).toBe(2);
  });
});
