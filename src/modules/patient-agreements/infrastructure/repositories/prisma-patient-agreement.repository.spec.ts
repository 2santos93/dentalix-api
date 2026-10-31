/**
 * El pagador del convenio asignado llega con su tipo genérico: SEC-047 mira
 * ese tipo (OTHER es interno).
 */
import {
  toEntity,
  type PatientAgreementRow,
} from './prisma-patient-agreement.repository';

const AT = new Date('2026-10-29T00:00:00.000Z');

function row(
  type: PatientAgreementRow['agreement']['payer']['type'],
): PatientAgreementRow {
  return {
    id: 'assignment-1',
    tenantId: 'tenant-1',
    patientId: 'patient-1',
    agreementId: 'agreement-1',
    coverageId: null,
    validFrom: null,
    validTo: null,
    notes: null,
    createdById: null,
    updatedById: null,
    createdAt: AT,
    updatedAt: AT,
    deletedAt: null,
    agreement: {
      id: 'agreement-1',
      name: 'Cortesía socios',
      kind: 'PERCENT_DISCOUNT',
      active: true,
      validFrom: null,
      validTo: null,
      payer: { id: 'payer-1', name: 'Cortesía', type },
    },
  };
}

describe('mapper de asignaciones de convenio (DX-326)', () => {
  it('the payer of a patient agreement row keeps its generic type', () => {
    expect(toEntity(row('OTHER')).agreement.payer).toEqual({
      id: 'payer-1',
      name: 'Cortesía',
      type: 'OTHER',
    });
    expect(toEntity(row('EMPLOYER')).agreement.payer.type).toBe('EMPLOYER');
  });
});
