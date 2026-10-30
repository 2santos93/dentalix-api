import { ClinicRole } from '@prisma/client';
import type { AuditEventDraft } from '../../audit/domain/audit-event';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';

/**
 * DX-359: `POST /auth/register/verify` crea la clínica, su sede principal y
 * su dueño. El evento lo protagoniza el dueño recién creado (ADMIN, todas las
 * sedes) en la clínica nueva. Ni el email, ni el nombre, ni el subdominio, ni
 * nada de la contraseña o del token del enlace.
 */
export function clinicRegisteredAuditEvent(
  request: AuditRequestMeta | null,
  created: { tenantId: string; userId: string; locationId: string },
): AuditEventDraft {
  return {
    tenantId: created.tenantId,
    locationId: created.locationId,
    actor: { kind: 'user', userId: created.userId, role: ClinicRole.ADMIN },
    patient: null,
    requestId: request?.requestId ?? null,
    ip: request?.ip ?? null,
    userAgent: request?.userAgent ?? null,
    action: 'CREATE',
    resourceType: 'CLINIC',
    resourceId: created.tenantId,
    metadata: {
      reason: 'CLINIC_REGISTERED',
      staffAccess: { after: { role: ClinicRole.ADMIN, locationIds: null } },
    },
  };
}
