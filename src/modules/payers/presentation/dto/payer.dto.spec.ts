import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
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
  it('acepta un alta válida con y sin país', async () => {
    expect(
      await messages(CreatePayerDto, {
        name: 'Sura',
        type: 'EPS_CO',
        country: 'CO',
      }),
    ).toEqual([]);
    expect(
      await messages(CreatePayerDto, { name: 'Sura', type: 'OTRO' }),
    ).toEqual([]);
  });

  it('rechaza nombre ausente, corto, largo y de otro tipo con el mensaje en español', async () => {
    for (const name of [undefined, '', 'A', 'x'.repeat(121), 5]) {
      const out = await messages(CreatePayerDto, { name, type: 'OTRO' });
      expect(out).toContain(PAYER_NAME_MESSAGE);
    }
  });

  it('rechaza tipo y país fuera del enum', async () => {
    const out = await messages(CreatePayerDto, {
      name: 'Sura',
      type: 'XX',
      country: 'MX',
    });
    expect(out).toEqual([
      expect.stringMatching(/^El tipo de pagador debe ser uno de/),
      expect.stringMatching(/^El país debe ser uno de/),
    ]);
  });

  it('el PATCH admite campos sueltos y valida active', async () => {
    expect(await messages(UpdatePayerDto, {})).toEqual([]);
    expect(await messages(UpdatePayerDto, { active: false })).toEqual([]);
    expect(await messages(UpdatePayerDto, { country: null })).toEqual([]);
    expect(await messages(UpdatePayerDto, { active: 'no' })).toHaveLength(1);
  });

  it('includeInactive acepta solo "true" como verdadero', () => {
    const q = (v: unknown) =>
      plainToInstance(ListPayersQueryDto, { includeInactive: v })
        .includeInactive;
    expect(q('true')).toBe(true);
    expect(q('false')).toBe(false);
    expect(q(undefined)).toBe(false);
  });
});
