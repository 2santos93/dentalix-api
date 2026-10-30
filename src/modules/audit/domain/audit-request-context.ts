import type { ClinicRole } from '@prisma/client';
import type { AuditEventDraft } from './audit-event';

/**
 * Desde dónde llega una petición (DX-359), sin el quién: una ruta pública
 * cuyo actor resuelve la propia escritura (aceptar una invitación, verificar
 * el registro) o una sesión sin clínica (plataforma).
 */
export interface AuditRequestMeta {
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Quién hace una escritura y desde dónde, para los `audit_event` que escribe
 * un caso de uso (no el AuditInterceptor): el movimiento de una cita (DX-121),
 * que necesita el antes, y las altas y bajas de «Pendientes por agendar»
 * (DX-122), que conocen al paciente.
 */
export interface AuditRequestContext {
  tenantId: string;
  locationId: string | null;
  actor: { userId: string; role: ClinicRole | null };
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Evento de una escritura hecha con sesión de clínica (DX-359): quién y desde
 * dónde salen del contexto; qué, del caso de uso. Sin paciente: es para los
 * eventos de personal y de cuenta, que no tocan a ninguno.
 */
export function auditDraftFromContext(
  ctx: AuditRequestContext,
  event: Pick<
    AuditEventDraft,
    'action' | 'resourceType' | 'resourceId' | 'metadata'
  >,
): AuditEventDraft {
  return {
    tenantId: ctx.tenantId,
    locationId: ctx.locationId,
    actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
    patient: null,
    requestId: ctx.requestId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    ...event,
  };
}
