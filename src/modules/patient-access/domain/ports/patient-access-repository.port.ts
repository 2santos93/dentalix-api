import type { AppointmentStatus, PatientAccessScope } from '@prisma/client';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import type { HourCycle } from '../../../../shared/format/regional-format';
import type { VerifyDecision } from '../patient-access';

export const PATIENT_ACCESS_REPOSITORY = Symbol('PATIENT_ACCESS_REPOSITORY');

/** Lo que el personal necesita del paciente para compartir el enlace. */
export interface AccessLinkPatient {
  id: string;
  firstName: string;
  birthDate: Date | null;
  phone: string | null;
  deletedAt: Date | null;
}

/** Contexto de la clínica para el mensaje y el aviso de menor. */
export interface AccessLinkClinicContext {
  clinicName: string;
  /** Región telefónica de la sede activa o principal (para `wa.me`). */
  phoneRegion: string | null;
  /** Formato de esa sede (la caducidad en el mensaje). */
  location: { id: string; locale: string | null; hourCycle: string | null };
  majorityAge: number;
  /** Zona de la sede activa o principal: da «hoy» para la edad. */
  timeZone: string;
}

export interface IssueAccessLinkInput {
  id: string;
  patientId: string;
  tokenHash: string;
  scopes: PatientAccessScope[];
  expiresAt: Date;
  createdById: string;
}

/** Fila de la lista de la ficha: nunca el token ni la URL. */
export interface AccessLinkRow {
  id: string;
  scopes: PatientAccessScope[];
  createdAt: Date;
  expiresAt: Date;
  lastViewedAt: Date | null;
  lockedUntil: Date | null;
  createdBy: { id: string; fullName: string | null };
}

export type RevokeOutcome = 'REVOKED' | 'ALREADY_REVOKED' | 'NOT_FOUND';

/**
 * Resultado de una verificación hecha con la fila bloqueada. `NO_LINK`: el
 * hash no casa con un enlace vivo de esta clínica (o el paciente está
 * archivado): quien llama lo trata como un token desconocido.
 */
export type VerifyAttemptOutcome =
  | { kind: 'NO_LINK' }
  | {
      kind: 'DECIDED';
      linkId: string;
      patientId: string;
      decision: VerifyDecision;
    };

/** El enlace de la sesión, releído en cada petición. */
export interface SessionLink {
  id: string;
  patientId: string;
  scopes: PatientAccessScope[];
  expiresAt: Date;
  revokedAt: Date | null;
  /** El paciente fue archivado: el enlace ya no sirve. */
  patientArchived: boolean;
}

export interface PortalPatient {
  firstName: string;
  birthDate: Date | null;
}

export interface PortalAppointment {
  id: string;
  start: Date;
  end: Date;
  status: AppointmentStatus;
  typeName: string | null;
  providerName: string | null;
  location: {
    name: string;
    address: string | null;
    timeZone: string | null;
    locale: string | null;
    hourCycle: HourCycle | null;
  };
}

export interface PortalPlanRef {
  id: string;
  status: 'PRESENTED' | 'ACCEPTED';
  optionGroupId: string | null;
  optionLabel: string | null;
}

export interface PatientAccessRepository {
  // --- personal ------------------------------------------------------------
  findPatient(patientId: string): Promise<AccessLinkPatient | null>;
  clinicContext(): Promise<AccessLinkClinicContext>;
  /** Alta del enlace (409 si el paciente se archivó entre medias). */
  issue(input: IssueAccessLinkInput): Promise<void>;
  /** Vivos del paciente (ni revocados ni caducados); `null` si no existe. */
  listLive(patientId: string, now: Date): Promise<AccessLinkRow[] | null>;
  revoke(
    patientId: string,
    linkId: string,
    revokedById: string,
  ): Promise<RevokeOutcome>;

  // --- público -------------------------------------------------------------
  /**
   * Verificación con la fila del enlace BLOQUEADA (`FOR UPDATE`) en una sola
   * transacción: `decide` recibe el contador y la fecha guardada, y lo que
   * devuelve se escribe (contador, bloqueo, último acceso y auditoría) antes
   * de soltar el candado. Dos verificaciones simultáneas se serializan.
   */
  verifyAttempt(
    tokenHash: string,
    decide: (state: {
      failedAttempts: number;
      lockedUntil: Date | null;
      birthDate: Date | null;
      dbNow: Date;
    }) => VerifyDecision,
    meta: AuditRequestMeta,
  ): Promise<VerifyAttemptOutcome>;
  findSessionLink(linkId: string): Promise<SessionLink | null>;
  portalPatient(patientId: string): Promise<PortalPatient | null>;
  upcomingAppointments(
    patientId: string,
    now: Date,
  ): Promise<PortalAppointment[]>;
  /** Planes PRESENTED o ACCEPTED del paciente, del más reciente al más antiguo. */
  sharedPlans(patientId: string): Promise<PortalPlanRef[]>;
  /** ¿Es una cita futura, confirmable, de ESTE paciente? */
  findConfirmableAppointment(
    patientId: string,
    appointmentId: string,
    now: Date,
  ): Promise<boolean>;
}
