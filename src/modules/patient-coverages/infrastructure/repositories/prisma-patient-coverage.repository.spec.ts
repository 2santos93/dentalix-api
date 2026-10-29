/**
 * Excepción G5.3 (DX-334): tipos de pagador anteriores a DX-326.
 *
 * El pagador de una cobertura llega con su tipo genérico y sin país (spec R4, R8).
 */
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
    migratedFromInsurerEps: false,
    createdById: null,
    updatedById: null,
    declaredById: null,
    verifiedById: null,
    verifiedAt: null,
    createdAt: AT,
    updatedAt: AT,
    deletedAt: null,
    payer: { id: 'payer-1', name: 'Sura EPS', type, active: true },
  };
}

describe('mapper de coberturas (DX-326, fase 1)', () => {
  it('legacy code in a coverage row maps to its generic type and the payer has no country', () => {
    const coverage = toEntity(row('EPS_CO'), new Map());
    expect(coverage.payer).toEqual({
      id: 'payer-1',
      name: 'Sura EPS',
      type: 'PUBLIC_SYSTEM',
      active: true,
    });
    expect(toEntity(row('OTRO'), new Map()).payer.type).toBe('OTHER');
  });
});
