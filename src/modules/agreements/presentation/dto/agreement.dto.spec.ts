import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import {
  AGREEMENT_DATE_FORMAT_MESSAGE,
  AGREEMENT_NAME_MESSAGE,
  AGREEMENT_PERCENT_BY_CATEGORY_MESSAGE,
  AGREEMENT_PERCENT_RANGE_MESSAGE,
} from '../../domain/agreement-rules';
import {
  CreateAgreementDto,
  ListAgreementsQueryDto,
  UpdateAgreementDto,
} from './agreement.dto';
import { isPercentByCategory } from './percent-by-category.validator';

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
const base = { name: 'Sanavida', payerId: ID, kind: 'PERCENT_DISCOUNT' };

describe('DTOs de convenios (DX-105)', () => {
  describe('alta', () => {
    it('acepta un descuento y una lista de precios', async () => {
      expect(
        await messages(CreateAgreementDto, {
          ...base,
          percent: 12.5,
          percentByCategory: { Operatoria: 20 },
          validFrom: '2026-01-01',
          locationId: ID,
        }),
      ).toEqual([]);
      expect(
        await messages(CreateAgreementDto, {
          ...base,
          kind: 'PRICE_LIST',
          priceListId: ID,
        }),
      ).toEqual([]);
    });

    it('rechaza nombre ausente, corto, largo y de otro tipo', async () => {
      for (const name of [undefined, '', 'A', 'x'.repeat(121), 5]) {
        expect(
          await messages(CreateAgreementDto, { ...base, name, percent: 1 }),
        ).toContain(AGREEMENT_NAME_MESSAGE);
      }
    });

    it('rechaza pagador, tipo, lista y sede mal formados', async () => {
      expect((await messages(CreateAgreementDto, {})).length).toBeGreaterThan(
        0,
      );
      expect(
        await messages(CreateAgreementDto, { ...base, payerId: 'no-uuid' }),
      ).toContain('El pagador debe ser un identificador válido.');
      expect(
        await messages(CreateAgreementDto, { ...base, kind: 'OTRO' }),
      ).toEqual([expect.stringContaining('El tipo de convenio')]);
      expect(
        await messages(CreateAgreementDto, { ...base, priceListId: 'x' }),
      ).toContain('La lista de precios debe ser un identificador válido.');
      expect(
        await messages(CreateAgreementDto, { ...base, locationId: 'x' }),
      ).toContain('La sede debe ser un identificador válido.');
    });

    it('el porcentaje: 0–100 y hasta 2 decimales', async () => {
      for (const ok of [0, 100, 33.33]) {
        expect(
          await messages(CreateAgreementDto, { ...base, percent: ok }),
        ).toEqual([]);
      }
      for (const bad of [-1, 100.01, 10.123, '10', Number.NaN]) {
        expect(
          await messages(CreateAgreementDto, { ...base, percent: bad }),
        ).toContain(AGREEMENT_PERCENT_RANGE_MESSAGE);
      }
    });

    it('las fechas son AAAA-MM-DD', async () => {
      expect(
        await messages(CreateAgreementDto, {
          ...base,
          percent: 1,
          validTo: '31/12/2026',
        }),
      ).toContain(AGREEMENT_DATE_FORMAT_MESSAGE);
    });

    it('percentByCategory mal formado da el mensaje en español', async () => {
      for (const bad of ['texto', [], { A: 101 }, { '': 5 }, { A: '5' }]) {
        expect(
          await messages(CreateAgreementDto, {
            ...base,
            percent: 1,
            percentByCategory: bad,
          }),
        ).toContain(AGREEMENT_PERCENT_BY_CATEGORY_MESSAGE);
      }
    });
  });

  describe('percentByCategory', () => {
    it('acepta un objeto de claves no vacías con porcentajes 0–100 de 2 decimales', () => {
      expect(isPercentByCategory({})).toBe(true);
      expect(isPercentByCategory({ A: 0, B: 100, C: 12.34 })).toBe(true);
    });

    it('rechaza no-objetos, claves vacías o largas y valores inválidos', () => {
      expect(isPercentByCategory(null)).toBe(false);
      expect(isPercentByCategory([1])).toBe(false);
      expect(isPercentByCategory({ '  ': 5 })).toBe(false);
      expect(isPercentByCategory({ ['x'.repeat(81)]: 5 })).toBe(false);
      expect(isPercentByCategory({ A: -0.01 })).toBe(false);
      expect(isPercentByCategory({ A: 100.01 })).toBe(false);
      expect(isPercentByCategory({ A: 1.005 })).toBe(false);
      expect(isPercentByCategory({ A: Number.NaN })).toBe(false);
      expect(isPercentByCategory({ A: null })).toBe(false);
    });

    it('tope de 50 claves: 50 pasa, 51 no', () => {
      const make = (n: number) =>
        Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, 1]));
      expect(isPercentByCategory(make(50))).toBe(true);
      expect(isPercentByCategory(make(51))).toBe(false);
    });
  });

  describe('edición', () => {
    it('un cuerpo vacío es válido', async () => {
      expect(await messages(UpdateAgreementDto, {})).toEqual([]);
    });

    it('null en nombre, pagador, tipo o activo da 400, nunca 500', async () => {
      for (const field of ['name', 'payerId', 'kind', 'active']) {
        expect(
          (await messages(UpdateAgreementDto, { [field]: null })).length,
        ).toBeGreaterThan(0);
      }
    });

    it('null vacía porcentaje, categorías, lista, sede y fechas', async () => {
      expect(
        await messages(UpdateAgreementDto, {
          percent: null,
          percentByCategory: null,
          priceListId: null,
          locationId: null,
          validFrom: null,
          validTo: null,
        }),
      ).toEqual([]);
    });
  });

  describe('listado', () => {
    it('includeInactive acepta true/false como texto', async () => {
      const dto = plainToInstance(ListAgreementsQueryDto, {
        includeInactive: 'true',
      });
      expect(dto.includeInactive).toBe(true);
      expect(await messages(ListAgreementsQueryDto, {})).toEqual([]);
    });
  });
});
