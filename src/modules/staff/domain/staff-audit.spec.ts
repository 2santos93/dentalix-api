import { ClinicRole } from '@prisma/client';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { sanitizeAuditMetadata } from '../../audit/domain/audit-metadata';
import {
  staffStatusAuditEvent,
  staffUpdateAuditEvent,
  type StaffAccessSnapshot,
} from './staff-audit';

const TENANT = '0192f0a0-0000-7000-8000-000000000001';
const ADMIN = '0192f0a0-0000-7000-8000-000000000002';
const MEMBER = '0192f0a0-0000-7000-8000-000000000003';
const LOC_A = '0192f0a0-0000-7000-8000-0000000000aa';

const ctx: AuditRequestContext = {
  tenantId: TENANT,
  locationId: LOC_A,
  actor: { userId: ADMIN, role: ClinicRole.ADMIN },
  requestId: 'req-1',
  ip: '10.0.0.1',
  userAgent: 'jest',
};

const before: StaffAccessSnapshot = {
  fullName: 'Ana Pérez',
  role: ClinicRole.DENTIST,
  locationIds: [LOC_A],
  professionalLicense: 'RP-1',
  professionalSpecialty: null,
};

describe('staffUpdateAuditEvent (DX-359)', () => {
  it('quién, qué y antes/después de los campos de acceso que cambiaron', () => {
    const event = staffUpdateAuditEvent(ctx, MEMBER, before, {
      ...before,
      role: ClinicRole.ADMIN,
      locationIds: null,
      professionalSpecialty: 'Ortodoncia',
    });
    expect(event).toEqual({
      tenantId: TENANT,
      locationId: LOC_A,
      actor: { kind: 'user', userId: ADMIN, role: ClinicRole.ADMIN },
      patient: null,
      requestId: 'req-1',
      ip: '10.0.0.1',
      userAgent: 'jest',
      action: 'UPDATE',
      resourceType: 'STAFF_MEMBER',
      resourceId: MEMBER,
      metadata: {
        reason: 'STAFF_UPDATED',
        changedFields: ['locationIds', 'professionalSpecialty', 'role'],
        staffAccess: {
          before: {
            role: ClinicRole.DENTIST,
            locationIds: [LOC_A],
            professionalSpecialty: null,
          },
          after: {
            role: ClinicRole.ADMIN,
            locationIds: null,
            professionalSpecialty: 'Ortodoncia',
          },
        },
      },
    });
    // La metadata ya cumple la lista cerrada: el saneado no quita nada.
    expect(sanitizeAuditMetadata(event?.metadata)).toEqual(event?.metadata);
  });

  it('el nombre cuenta como campo cambiado, pero sin su valor', () => {
    const event = staffUpdateAuditEvent(ctx, MEMBER, before, {
      ...before,
      fullName: 'Ana P. Gómez',
    });
    expect(event?.metadata).toEqual({
      reason: 'STAFF_UPDATED',
      changedFields: ['fullName'],
    });
    expect(JSON.stringify(event)).not.toContain('Ana');
  });

  it('sin cambios no hay evento', () => {
    expect(
      staffUpdateAuditEvent(ctx, MEMBER, before, { ...before }),
    ).toBeNull();
  });
});

describe('staffStatusAuditEvent (DX-359)', () => {
  it('desactivar: ACTIVE → INACTIVE', () => {
    expect(staffStatusAuditEvent(ctx, MEMBER, 'DEACTIVATED')).toMatchObject({
      action: 'UPDATE',
      resourceType: 'STAFF_MEMBER',
      resourceId: MEMBER,
      actor: { kind: 'user', userId: ADMIN, role: ClinicRole.ADMIN },
      metadata: {
        reason: 'STAFF_DEACTIVATED',
        statusChange: { from: 'ACTIVE', to: 'INACTIVE' },
      },
    });
  });

  it('reactivar: INACTIVE → ACTIVE', () => {
    expect(staffStatusAuditEvent(ctx, MEMBER, 'REACTIVATED').metadata).toEqual({
      reason: 'STAFF_REACTIVATED',
      statusChange: { from: 'INACTIVE', to: 'ACTIVE' },
    });
  });
});
