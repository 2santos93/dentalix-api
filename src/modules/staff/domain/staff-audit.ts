import type { ClinicRole } from '@prisma/client';
import type { AuditEventDraft } from '../../audit/domain/audit-event';
import type { AuditStaffAccessSide } from '../../audit/domain/audit-metadata';
import {
  auditDraftFromContext,
  type AuditRequestContext,
} from '../../audit/domain/audit-request-context';

/**
 * Lo que `PATCH /staff/:userId` puede cambiar de un miembro, leído en la
 * transacción del cambio (DX-359). `locationIds: null` = todas las sedes.
 */
export interface StaffAccessSnapshot {
  fullName: string;
  role: ClinicRole;
  locationIds: string[] | null;
  professionalLicense: string | null;
  professionalSpecialty: string | null;
}

/** Campos de acceso cuyo antes y después se guardan (nunca el nombre). */
const ACCESS_FIELDS = [
  'role',
  'locationIds',
  'professionalLicense',
  'professionalSpecialty',
] as const;

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * DX-359: evento de `PATCH /staff/:userId` con los campos que de verdad
 * cambiaron. Rol, sedes (ascender a ADMIN las vacía: pasan a «todas»),
 * registro profesional y especialidad llevan su antes y después; el nombre
 * solo figura en `changedFields`, sin su valor. `null` si nada cambió (no hay
 * evento, como en los ajustes de DX-324).
 */
export function staffUpdateAuditEvent(
  ctx: AuditRequestContext,
  userId: string,
  before: StaffAccessSnapshot,
  after: StaffAccessSnapshot,
): AuditEventDraft | null {
  const changed: string[] = [];
  const beforeSide: AuditStaffAccessSide = {};
  const afterSide: AuditStaffAccessSide = {};
  for (const field of ACCESS_FIELDS) {
    if (sameValue(before[field], after[field])) continue;
    changed.push(field);
    Object.assign(beforeSide, { [field]: before[field] });
    Object.assign(afterSide, { [field]: after[field] });
  }
  if (before.fullName !== after.fullName) changed.push('fullName');
  if (changed.length === 0) return null;
  return auditDraftFromContext(ctx, {
    action: 'UPDATE',
    resourceType: 'STAFF_MEMBER',
    resourceId: userId,
    metadata: {
      reason: 'STAFF_UPDATED',
      changedFields: changed.sort(),
      ...(Object.keys(afterSide).length > 0
        ? { staffAccess: { before: beforeSide, after: afterSide } }
        : {}),
    },
  });
}

/**
 * DX-359: desactivar (`DELETE /staff/:userId`) o reactivar un miembro. El
 * estado de su membresía antes y después; nada más.
 */
export function staffStatusAuditEvent(
  ctx: AuditRequestContext,
  userId: string,
  change: 'DEACTIVATED' | 'REACTIVATED',
): AuditEventDraft {
  return auditDraftFromContext(ctx, {
    action: 'UPDATE',
    resourceType: 'STAFF_MEMBER',
    resourceId: userId,
    metadata: {
      reason: `STAFF_${change}`,
      statusChange:
        change === 'DEACTIVATED'
          ? { from: 'ACTIVE', to: 'INACTIVE' }
          : { from: 'INACTIVE', to: 'ACTIVE' },
    },
  });
}
