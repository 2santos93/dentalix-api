import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import {
  PRICE_LIST_ITEMS_MAX,
  PRICE_LIST_NAME_MESSAGE,
} from '../../domain/price-list-rules';
import {
  CreatePriceListDto,
  ListPriceListItemsQueryDto,
  ListPriceListsQueryDto,
  ReplacePriceListItemsDto,
  UpdatePriceListDto,
} from './price-list.dto';

function flatten(errors: ValidationError[]): string[] {
  return errors.flatMap((e) => [
    ...Object.values(e.constraints ?? {}),
    ...flatten(e.children ?? []),
  ]);
}

async function messages(cls: new () => object, plain: object) {
  return flatten(await validate(plainToInstance(cls, plain)));
}

const ID = '11111111-1111-4111-8111-111111111111';

describe('DTOs de listas de precios (DX-105)', () => {
  describe('alta', () => {
    it('acepta un alta válida con y sin sede', async () => {
      expect(
        await messages(CreatePriceListDto, { name: 'Surco', currency: 'COP' }),
      ).toEqual([]);
      expect(
        await messages(CreatePriceListDto, {
          name: 'Surco',
          currency: 'COP',
          locationId: ID,
        }),
      ).toEqual([]);
    });

    it('rechaza nombre ausente, corto, largo y de otro tipo con el mensaje en español', async () => {
      for (const name of [undefined, '', 'A', 'x'.repeat(121), 5]) {
        expect(
          await messages(CreatePriceListDto, { name, currency: 'COP' }),
        ).toContain(PRICE_LIST_NAME_MESSAGE);
      }
    });

    it('rechaza moneda ausente o que no es de 3 letras y sede que no es uuid', async () => {
      expect(
        (await messages(CreatePriceListDto, { name: 'Surco' })).length,
      ).toBeGreaterThan(0);
      expect(
        (
          await messages(CreatePriceListDto, {
            name: 'Surco',
            currency: 'PESOS',
          })
        ).length,
      ).toBeGreaterThan(0);
      expect(
        await messages(CreatePriceListDto, {
          name: 'Surco',
          currency: 'COP',
          locationId: 'norte',
        }),
      ).toHaveLength(1);
    });
  });

  describe('PATCH', () => {
    it('admite campos sueltos, la sede null y valida active', async () => {
      expect(await messages(UpdatePriceListDto, {})).toEqual([]);
      expect(await messages(UpdatePriceListDto, { active: false })).toEqual([]);
      expect(await messages(UpdatePriceListDto, { locationId: null })).toEqual(
        [],
      );
      expect(await messages(UpdatePriceListDto, { active: 'no' })).toHaveLength(
        1,
      );
    });

    it.each(['name', 'currency', 'active'])(
      'rechaza %s: null (columna NOT NULL)',
      async (key) => {
        expect(
          (await messages(UpdatePriceListDto, { [key]: null })).length,
        ).toBeGreaterThan(0);
      },
    );
  });

  describe('consultas', () => {
    it('includeInactive acepta solo "true" como verdadero', () => {
      const q = (v: unknown) =>
        plainToInstance(ListPriceListsQueryDto, { includeInactive: v })
          .includeInactive;
      expect(q('true')).toBe(true);
      expect(q('false')).toBe(false);
      expect(q(undefined)).toBe(false);
    });

    it('page y pageSize son enteros >= 1', async () => {
      expect(
        await messages(ListPriceListItemsQueryDto, {
          query: 'endo',
          page: '2',
          pageSize: '50',
        }),
      ).toEqual([]);
      expect(
        (await messages(ListPriceListItemsQueryDto, { page: '0' })).length,
      ).toBeGreaterThan(0);
      expect(
        (await messages(ListPriceListItemsQueryDto, { pageSize: 'x' })).length,
      ).toBeGreaterThan(0);
    });
  });

  describe('PUT de precios', () => {
    it('acepta precios con 2 decimales, 0 y null', async () => {
      expect(
        await messages(ReplacePriceListItemsDto, {
          items: [
            { catalogItemId: ID, price: 150000.5 },
            { catalogItemId: ID, price: 0 },
            { catalogItemId: ID, price: null },
          ],
        }),
      ).toEqual([]);
    });

    it('rechaza precio negativo, con 3 decimales, de texto o AUSENTE', async () => {
      for (const price of [-1, 10.123, '10', undefined]) {
        expect(
          (
            await messages(ReplacePriceListItemsDto, {
              items: [{ catalogItemId: ID, price }],
            })
          ).length,
        ).toBeGreaterThan(0);
      }
    });

    it('rechaza una prestación que no es uuid', async () => {
      expect(
        (
          await messages(ReplacePriceListItemsDto, {
            items: [{ catalogItemId: 'x', price: 1 }],
          })
        ).length,
      ).toBeGreaterThan(0);
    });

    it('acepta 500 filas y rechaza 501 o un cuerpo sin arreglo', async () => {
      const rows = (n: number) =>
        Array.from({ length: n }, () => ({ catalogItemId: ID, price: 1 }));
      expect(
        await messages(ReplacePriceListItemsDto, {
          items: rows(PRICE_LIST_ITEMS_MAX),
        }),
      ).toEqual([]);
      expect(
        await messages(ReplacePriceListItemsDto, {
          items: rows(PRICE_LIST_ITEMS_MAX + 1),
        }),
      ).toEqual([`Máximo ${PRICE_LIST_ITEMS_MAX} precios por envío.`]);
      expect(
        (await messages(ReplacePriceListItemsDto, {})).length,
      ).toBeGreaterThan(0);
    });
  });
});
