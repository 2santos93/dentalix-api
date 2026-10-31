/** El pagador de una cobertura llega con su tipo genérico y sin país (DX-326, spec R4, R8). */
import {
  toEntity,
  type PatientCoverageRow,
} from './prisma-patient-coverage.repository';

const AT = new Date('2026-10-29T00:00:00.000Z');

function row(type: PatientCoverageRow['payer']['type']): PatientCoverageRow {
  return {
    id: 'coverage-1',
    tenantId: 'tenant-1',
    patientId: 'patient-1',
    payerId: 'payer-1',
    planName: null,
    memberNumber: '1234',
    policyHolderName: null,
    validFrom: null,
    validTo: null,
    isPrimary: true,
    notes: null,
    migratedFromLegacyInsurer: false,
    createdById: null,
    updatedById: null,
    declaredById: null,
    verifiedById: null,
    verifiedAt: null,
    createdAt: AT,
    updatedAt: AT,
    deletedAt: null,
    payer: { id: 'payer-1', name: 'Surco Salud', type, active: true },
  };
}

describe('mapper de coberturas (DX-326)', () => {
  it('the payer of a coverage row keeps its generic type and has no country', () => {
    const coverage = toEntity(row('PUBLIC_SYSTEM'), new Map());
    expect(coverage.payer).toEqual({
      id: 'payer-1',
      name: 'Surco Salud',
      type: 'PUBLIC_SYSTEM',
      active: true,
    });
    expect(toEntity(row('OTHER'), new Map()).payer.type).toBe('OTHER');
  });
});
