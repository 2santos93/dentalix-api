import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AGREEMENT_DATE_FORMAT_MESSAGE } from '../../../agreements/domain/agreement-rules';
import {
  AssignPatientAgreementDto,
  GetPatientAgreementQueryDto,
} from './patient-agreement.dto';

const AGREEMENT = '0b1a1d5e-8c9e-4f1a-9a3e-2f6a1b7c8d90';

async function messages(cls: new () => object, plain: object) {
  const errors = await validate(plainToInstance(cls, plain));
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('DTOs del convenio del paciente (DX-105)', () => {
  it('acepta una asignación mínima y una completa con nulos', async () => {
    expect(
      await messages(AssignPatientAgreementDto, { agreementId: AGREEMENT }),
    ).toEqual([]);
    expect(
      await messages(AssignPatientAgreementDto, {
        agreementId: AGREEMENT,
        coverageId: AGREEMENT,
        validFrom: '2026-01-01',
        validTo: '2026-12-31',
        notes: 'ok',
      }),
    ).toEqual([]);
    expect(
      await messages(AssignPatientAgreementDto, {
        agreementId: AGREEMENT,
        coverageId: null,
        validFrom: null,
        validTo: null,
        notes: null,
      }),
    ).toEqual([]);
  });

  it('exige un convenio uuid', async () => {
    for (const agreementId of [undefined, '', 'abc', 5]) {
      expect(
        (await messages(AssignPatientAgreementDto, { agreementId })).length,
      ).toBeGreaterThan(0);
    }
  });

  it('la cobertura, si viene, debe ser uuid', async () => {
    expect(
      (
        await messages(AssignPatientAgreementDto, {
          agreementId: AGREEMENT,
          coverageId: 'abc',
        })
      ).length,
    ).toBeGreaterThan(0);
  });

  it('rechaza fechas con otro formato con el mensaje en español', async () => {
    for (const validTo of ['01/01/2026', '2026-1-1', '2026-01-01T00:00:00Z']) {
      expect(
        await messages(AssignPatientAgreementDto, {
          agreementId: AGREEMENT,
          validTo,
        }),
      ).toContain(AGREEMENT_DATE_FORMAT_MESSAGE);
    }
  });

  it('las notas admiten 500 caracteres, no 501', async () => {
    const ok = { agreementId: AGREEMENT, notes: 'x'.repeat(500) };
    expect(await messages(AssignPatientAgreementDto, ok)).toEqual([]);
    expect(
      await messages(AssignPatientAgreementDto, {
        ...ok,
        notes: 'x'.repeat(501),
      }),
    ).toHaveLength(1);
  });

  it('includeHistory acepta true/false como texto de la query', async () => {
    const parse = (v: unknown) =>
      plainToInstance(GetPatientAgreementQueryDto, { includeHistory: v });
    expect(parse('true').includeHistory).toBe(true);
    expect(parse('false').includeHistory).toBe(false);
    expect(await validate(parse('true'))).toEqual([]);
  });
});
