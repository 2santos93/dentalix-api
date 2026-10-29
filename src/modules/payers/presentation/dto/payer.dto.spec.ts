import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PAYER_TYPES } from '../../domain/payer-type';
import { PAYER_NAME_MESSAGE } from '../../domain/payer-rules';
import {
  CreatePayerDto,
  ListPayersQueryDto,
  UpdatePayerDto,
} from './payer.dto';

async function messages(cls: new () => object, plain: object) {
  const errors = await validate(plainToInstance(cls, plain));
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('DTOs de pagadores (DX-153)', () => {
  it.each(PAYER_TYPES)(
    'type accepts the five generic types (%s)',
    async (type) => {
      expect(await messages(CreatePayerDto, { name: 'Sura', type })).toEqual(
        [],
      );
      expect(await messages(UpdatePayerDto, { type })).toEqual([]);
    },
  );

  it('legacy type codes in the body become their generic type', async () => {
    // Excepción G5.3 (DX-334): tipos de pagador anteriores a DX-326.
    const legacy = {
      MUTUA_ES: 'INSURER',
      PREPAGADA_CO: 'PREPAID_PLAN',
      EPS_CO: 'PUBLIC_SYSTEM',
      EMPRESA: 'EMPLOYER',
      OTRO: 'OTHER',
    };
    for (const [code, generic] of Object.entries(legacy)) {
      const create = plainToInstance(CreatePayerDto, {
        name: 'Sura',
        type: code,
      });
      expect(await validate(create)).toEqual([]);
      expect(create.type).toBe(generic);
      const update = plainToInstance(UpdatePayerDto, { type: code });
      expect(await validate(update)).toEqual([]);
      expect(update.type).toBe(generic);
    }
  });

  it('rechaza nombre ausente, corto, largo y de otro tipo con el mensaje en español', async () => {
    for (const name of [undefined, '', 'A', 'x'.repeat(121), 5]) {
      const out = await messages(CreatePayerDto, { name, type: 'OTHER' });
      expect(out).toContain(PAYER_NAME_MESSAGE);
    }
  });

  it('an unknown type is 400 with the generic list', async () => {
    for (const type of ['XX', 'constructor', '']) {
      const out = await messages(CreatePayerDto, { name: 'Sura', type });
      expect(out).toEqual([
        'El tipo de pagador debe ser uno de: INSURER, PREPAID_PLAN, PUBLIC_SYSTEM, EMPLOYER, OTHER.',
      ]);
    }
  });

  it('type null in the PATCH is 400', async () => {
    expect(
      (await messages(UpdatePayerDto, { type: null })).length,
    ).toBeGreaterThan(0);
  });

  it('el PATCH admite campos sueltos y valida active', async () => {
    expect(await messages(UpdatePayerDto, {})).toEqual([]);
    expect(await messages(UpdatePayerDto, { active: false })).toEqual([]);
    expect(await messages(UpdatePayerDto, { active: 'no' })).toHaveLength(1);
  });

  it.each(['name', 'type', 'active'])(
    'el PATCH rechaza %s: null',
    async (key) => {
      expect(
        (await messages(UpdatePayerDto, { [key]: null })).length,
      ).toBeGreaterThan(0);
    },
  );

  it('includeInactive acepta solo "true" como verdadero', () => {
    const q = (v: unknown) =>
      plainToInstance(ListPayersQueryDto, { includeInactive: v })
        .includeInactive;
    expect(q('true')).toBe(true);
    expect(q('false')).toBe(false);
    expect(q(undefined)).toBe(false);
  });
});
