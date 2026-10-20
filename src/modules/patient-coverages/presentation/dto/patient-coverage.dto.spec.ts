import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { COVERAGE_DATE_FORMAT_MESSAGE } from '../../domain/coverage-rules';
import {
  CreatePatientCoverageDto,
  UpdatePatientCoverageDto,
} from './patient-coverage.dto';

const PAYER = '0b1a1d5e-8c9e-4f1a-9a3e-2f6a1b7c8d90';

async function messages(cls: new () => object, plain: object) {
  const errors = await validate(plainToInstance(cls, plain));
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('DTOs de coberturas (DX-153)', () => {
  it('acepta un alta mínima y una completa', async () => {
    expect(
      await messages(CreatePatientCoverageDto, { payerId: PAYER }),
    ).toEqual([]);
    expect(
      await messages(CreatePatientCoverageDto, {
        payerId: PAYER,
        planName: 'Oro',
        memberNumber: '123',
        policyHolderName: 'Luis',
        validFrom: '2026-01-01',
        validTo: '2026-12-31',
        isPrimary: true,
        notes: 'ok',
      }),
    ).toEqual([]);
  });

  it('exige un pagador uuid', async () => {
    for (const payerId of [undefined, '', 'abc', 5]) {
      expect(
        (await messages(CreatePatientCoverageDto, { payerId })).length,
      ).toBeGreaterThan(0);
    }
  });

  it('rechaza fechas con otro formato con el mensaje en español', async () => {
    for (const validFrom of [
      '01/01/2026',
      '2026-1-1',
      '2026-01-01T00:00:00Z',
    ]) {
      expect(
        await messages(CreatePatientCoverageDto, { payerId: PAYER, validFrom }),
      ).toContain(COVERAGE_DATE_FORMAT_MESSAGE);
    }
  });

  it('respeta las longitudes: 120, 60, 200 y 500', async () => {
    const ok = {
      payerId: PAYER,
      planName: 'x'.repeat(120),
      memberNumber: 'x'.repeat(60),
      policyHolderName: 'x'.repeat(200),
      notes: 'x'.repeat(500),
    };
    expect(await messages(CreatePatientCoverageDto, ok)).toEqual([]);
    for (const field of [
      'planName',
      'memberNumber',
      'policyHolderName',
      'notes',
    ] as const) {
      const out = await messages(CreatePatientCoverageDto, {
        ...ok,
        [field]: `${ok[field]}x`,
      });
      expect(out).toHaveLength(1);
    }
  });

  it('en PATCH todo es opcional y null vacía textos y fechas', async () => {
    expect(await messages(UpdatePatientCoverageDto, {})).toEqual([]);
    expect(
      await messages(UpdatePatientCoverageDto, {
        planName: null,
        memberNumber: null,
        policyHolderName: null,
        validFrom: null,
        validTo: null,
        notes: null,
      }),
    ).toEqual([]);
  });

  it('en PATCH el pagador y isPrimary no admiten null', async () => {
    expect(
      (await messages(UpdatePatientCoverageDto, { payerId: null })).length,
    ).toBeGreaterThan(0);
    expect(
      (await messages(UpdatePatientCoverageDto, { isPrimary: null })).length,
    ).toBeGreaterThan(0);
    expect(
      await messages(UpdatePatientCoverageDto, {
        payerId: PAYER,
        isPrimary: false,
      }),
    ).toEqual([]);
  });
});
