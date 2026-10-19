import type {
  AuditAction,
  AuditResourceType,
  ClinicRole,
} from '@prisma/client';
import type { AuditMetadata } from './audit-metadata';

/**
 * De dónde sale el paciente de un evento. Se resuelve bajo RLS al escribir:
 * un id de otra clínica (o inexistente) queda como `null`, nunca se guarda.
 */
export type AuditPatientRef = {
  kind:
    | 'patient'
    | 'treatmentPlan'
    | 'treatmentPlanItem'
    | 'payment'
    | 'prescription'
    | 'patientImplant'
    // DX-212: `GET /clinical-entries/:id/rda-readiness`.
    | 'clinicalEntry';
  id: string;
};

/**
 * Quién. `email` solo en un login fallido: se resuelve a un MIEMBRO de esta
 * clínica (nunca a un usuario de otra, que filtraría quién usa Dentalix) y el
 * email en sí no se guarda. `patient`: el propio paciente (DX-128, baja de
 * los recordatorios por enlace o mensaje), que no es un usuario: el evento va
 * sin actor y la BD solo lo admite para esa escritura (audit_events_actor_check).
 * `system`: un trabajo programado (DX-150, el barrido de cobranza que cierra
 * compromisos de pago); tampoco lleva usuario y la BD solo lo admite para ese
 * cambio de estado con origen JOB.
 */
export type AuditActorRef =
  | { kind: 'user'; userId: string; role: ClinicRole | null }
  | { kind: 'email'; email: string }
  | { kind: 'patient' }
  | { kind: 'system' };

/** Tope del user agent guardado en un evento. */
export const MAX_AUDIT_USER_AGENT = 512;

/** Lo que el interceptor sabe de una petición auditada. */
export interface AuditEventDraft {
  tenantId: string;
  locationId: string | null;
  actor: AuditActorRef;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string | null;
  patient: AuditPatientRef | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: AuditMetadata;
}

/** Un evento tal como lo ve la pantalla de auditoría (solo ADMIN). */
export interface AuditEventView {
  id: string;
  occurredAt: Date;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId: string | null;
  locationId: string | null;
  /** Zona IANA de la sede del evento (o de la sede principal). */
  timeZone: string;
  actor: {
    id: string;
    /** `null` si ya no es resoluble (usuario fuera de la clínica). */
    fullName: string | null;
    role: ClinicRole | null;
  } | null;
  patient: { id: string; fullName: string } | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: AuditMetadata;
}

export interface AuditEventFilter {
  patientId?: string;
  actorUserId?: string;
  action?: AuditAction;
  resourceType?: AuditResourceType;
  /** Desde (incluido). */
  from: Date;
  /** Hasta (excluido). */
  to: Date;
}
