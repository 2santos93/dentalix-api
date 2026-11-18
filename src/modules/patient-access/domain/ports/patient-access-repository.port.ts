import type { AppointmentStatus, PatientAccessScope } from '@prisma/client';
import type {
  AuditRequestContext,
  AuditRequestMeta,
} from '../../../audit/domain/audit-request-context';
import type { HourCycle } from '../../../../shared/format/regional-format';
import type { PlanQuoteSource } from '../../../treatment-plans/domain/ports/plan-quote-repository.port';
import type {
  VerifyDecision,
  WhatsAppResponsibleCandidate,
} from '../patient-access';

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
  /**
   * DX-101-bis: para decidir si se puede aceptar desde el portal. El último
   * día válido guardado (`YYYY-MM-DD`, null si no vence), la zona VÁLIDA de
   * la sede de la presentación (null si no la tiene) y si otra opción de su
   * grupo ya está aceptada o completada.
   */
  quoteValidUntil: string | null;
  quoteTimeZone: string | null;
  siblingChosen: boolean;
}

/** DX-101-bis: lo que el caso de uso decide con el plan bloqueado. */
export interface PortalAcceptanceSeal {
  content: object;
  contentHash: string;
  acceptanceHash: string;
}

/**
 * DX-101-bis: aceptar un presupuesto desde el portal. `decide` recibe el
 * presupuesto releído con el plan y su grupo bloqueados, la hora de la BD de
 * la transacción y si otra opción del grupo ya está elegida; comprueba que se
 * puede aceptar y que es el mostrado (si no, LANZA) y devuelve lo que se
 * sella.
 */
export interface PortalAcceptanceInput {
  linkId: string;
  patientId: string;
  planId: string;
  signerName: string;
  /** PNG en base64, sin prefijo `data:`, ya validado. */
  signature: string;
  meta: AuditRequestMeta;
  decide: (
    source: PlanQuoteSource,
    ctx: { dbNow: Date; siblingChosen: boolean },
  ) => PortalAcceptanceSeal;
}

/** Para el email de confirmación, tras el COMMIT (sin nada clínico). */
export interface PortalAcceptanceConfirmation {
  /**
   * El destinatario de la firma a distancia (`resolveSignatureRecipient`,
   * como DX-415/DX-561): el paciente adulto o, si es menor, su responsable;
   * null = no se envía (sin email o con la baja de envíos).
   */
  to: string | null;
  /** Nombre de pila con el que se le saluda (el del destinatario). */
  greetingName: string | null;
  clinicName: string;
  location: {
    id: string;
    locale: string | null;
    hourCycle: string | null;
    timeZone: string;
  };
}

export type PortalAcceptanceOutcome =
  /** El plan no existe o no es de este paciente. */
  | { kind: 'NOT_FOUND' }
  /** Enlace revocado o caducado, o paciente archivado (como el guard). */
  | { kind: 'GONE' }
  | {
      kind: 'ACCEPTED';
      acceptedAt: Date;
      confirmation: PortalAcceptanceConfirmation;
    };

export interface PatientAccessRepository {
  // --- personal ------------------------------------------------------------
  findPatient(patientId: string): Promise<AccessLinkPatient | null>;
  clinicContext(): Promise<AccessLinkClinicContext>;
  /**
   * Responsables VIVOS del paciente (DX-342) con su teléfono (el del contacto
   * o el de la ficha del paciente responsable), por orden de alta.
   */
  responsibles(patientId: string): Promise<WhatsAppResponsibleCandidate[]>;
  /** Alta del enlace (409 si el paciente se archivó entre medias). */
  issue(input: IssueAccessLinkInput): Promise<void>;
  /** Vivos del paciente (ni revocados ni caducados); `null` si no existe. */
  listLive(patientId: string, now: Date): Promise<AccessLinkRow[] | null>;
  /**
   * Revoca y, SOLO si de verdad revoca, deja el DELETE de auditoría en la
   * misma transacción (revocar otra vez no deja otro evento).
   */
  revoke(
    patientId: string,
    linkId: string,
    audit: AuditRequestContext,
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
  /**
   * Planes PRESENTED o ACCEPTED del paciente, del más reciente al más
   * antiguo. Con `planId` (DX-101-bis), solo ese.
   */
  sharedPlans(patientId: string, planId?: string): Promise<PortalPlanRef[]>;
  /**
   * DX-101-bis: en UNA transacción, con el paciente vivo (FOR KEY SHARE, el
   * orden de archivar), el plan del paciente, el enlace RELEÍDO (FOR SHARE:
   * una revocación espera o ya se ve) y el plan y su grupo bloqueados
   * (núcleo compartido con DX-415): la aceptación con la evidencia PORTAL, el
   * plan aceptado y el evento de auditoría con actor paciente. Los errores de
   * `decide`, el de otra aceptación simultánea
   * (`PortalQuoteNotAcceptableError`) y los 409 de DX-109 se propagan.
   */
  acceptPlan(input: PortalAcceptanceInput): Promise<PortalAcceptanceOutcome>;
  /** ¿Es una cita futura, confirmable, de ESTE paciente? */
  findConfirmableAppointment(
    patientId: string,
    appointmentId: string,
    now: Date,
  ): Promise<boolean>;
}
