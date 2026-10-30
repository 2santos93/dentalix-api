import { ClinicRole } from '@prisma/client';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { sanitizeAuditMetadata } from '../../audit/domain/audit-metadata';
import {
  invitationAcceptedAuditEvent,
  invitationCreatedAuditEvent,
  invitationResentAuditEvent,
  invitationRevokedAuditEvent,
} from './invitation-audit';

const TENANT = '0192f0a0-0000-7000-8000-000000000001';
const ADMIN = '0192f0a0-0000-7000-8000-000000000002';
const INVITATION = '0192f0a0-0000-7000-8000-000000000004';
const USER = '0192f0a0-0000-7000-8000-000000000005';
const LOC = '0192f0a0-0000-7000-8000-0000000000aa';

const ctx: AuditRequestContext = {
  tenantId: TENANT,
  locationId: LOC,
  actor: { userId: ADMIN, role: ClinicRole.ADMIN },
  requestId: 'req-1',
  ip: '10.0.0.1',
  userAgent: 'jest',
};

const fromAdmin = {
  tenantId: TENANT,
  locationId: LOC,
  actor: { kind: 'user', userId: ADMIN, role: ClinicRole.ADMIN },
  patient: null,
  requestId: 'req-1',
  ip: '10.0.0.1',
  userAgent: 'jest',
};

describe('eventos de invitaciones al personal (DX-359)', () => {
  it('invitar: alta de la invitación con el rol invitado', () => {
    expect(
      invitationCreatedAuditEvent(ctx, INVITATION, ClinicRole.DENTIST),
    ).toEqual({
      ...fromAdmin,
      action: 'CREATE',
      resourceType: 'STAFF_INVITATION',
      resourceId: INVITATION,
      metadata: {
        reason: 'INVITATION_SENT',
        staffAccess: { after: { role: ClinicRole.DENTIST } },
      },
    });
  });

  it('reenviar: token nuevo, sin el token', () => {
    expect(invitationResentAuditEvent(ctx, INVITATION)).toEqual({
      ...fromAdmin,
      action: 'UPDATE',
      resourceType: 'STAFF_INVITATION',
      resourceId: INVITATION,
      metadata: { reason: 'INVITATION_RESENT' },
    });
  });

  it('retirar o sustituir: PENDING → REVOKED con su motivo', () => {
    expect(invitationRevokedAuditEvent(ctx, INVITATION, 'REVOKED')).toEqual({
      ...fromAdmin,
      action: 'VOID',
      resourceType: 'STAFF_INVITATION',
      resourceId: INVITATION,
      metadata: {
        reason: 'INVITATION_REVOKED',
        statusChange: { from: 'PENDING', to: 'REVOKED' },
      },
    });
    expect(
      invitationRevokedAuditEvent(ctx, INVITATION, 'REPLACED').metadata.reason,
    ).toBe('INVITATION_REPLACED');
  });

  it('aceptar: alta del miembro por él mismo, con rol, sedes y la invitación', () => {
    const event = invitationAcceptedAuditEvent(
      { requestId: 'req-2', ip: '10.0.0.2', userAgent: 'móvil' },
      {
        tenantId: TENANT,
        invitationId: INVITATION,
        userId: USER,
        role: ClinicRole.RECEPTION,
        locationIds: [LOC],
        reactivated: true,
      },
    );
    expect(event).toEqual({
      tenantId: TENANT,
      locationId: null,
      actor: { kind: 'user', userId: USER, role: ClinicRole.RECEPTION },
      patient: null,
      requestId: 'req-2',
      ip: '10.0.0.2',
      userAgent: 'móvil',
      action: 'CREATE',
      resourceType: 'STAFF_MEMBER',
      resourceId: USER,
      metadata: {
        reason: 'INVITATION_ACCEPTED',
        params: { invitationId: INVITATION },
        staffAccess: {
          after: { role: ClinicRole.RECEPTION, locationIds: [LOC] },
        },
        statusChange: { from: 'INACTIVE', to: 'ACTIVE' },
      },
    });
    expect(sanitizeAuditMetadata(event.metadata)).toEqual(event.metadata);
  });

  it('aceptar con una membresía nueva no lleva cambio de estado', () => {
    const event = invitationAcceptedAuditEvent(null, {
      tenantId: TENANT,
      invitationId: INVITATION,
      userId: USER,
      role: ClinicRole.ADMIN,
      locationIds: null,
      reactivated: false,
    });
    expect(event.metadata).toEqual({
      reason: 'INVITATION_ACCEPTED',
      params: { invitationId: INVITATION },
      staffAccess: { after: { role: ClinicRole.ADMIN, locationIds: null } },
    });
    expect(event.requestId).toBeNull();
  });
});
