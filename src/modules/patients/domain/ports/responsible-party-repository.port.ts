import type { DocType, ResponsibleRelationship } from '@prisma/client';
import type {
  NoticeLocation,
  NoticePatientFields,
  NoticeResponsible,
} from '../communication/notice-recipient';

export const RESPONSIBLE_PARTY_REPOSITORY = Symbol(
  'RESPONSIBLE_PARTY_REPOSITORY',
);

/** Un paciente de la clínica tal como sale en el bloque (sin nada clínico). */
export interface ResponsiblePatientSummary {
  id: string;
  firstName: string;
  lastName: string;
  docType: DocType;
  docNumber: string | null;
  email: string | null;
  phone: string | null;
}

/**
 * Un responsable del paciente (DX-203). Si es otro paciente, los datos de
 * contacto son los de SU ficha (no se copian); si es un contacto, los suyos.
 */
export interface ResponsiblePartyView {
  id: string;
  patientId: string;
  kind: 'PATIENT' | 'CONTACT';
  responsiblePatient: ResponsiblePatientSummary | null;
  fullName: string;
  docType: DocType | null;
  docNumber: string | null;
  email: string | null;
  phone: string | null;
  relationship: ResponsibleRelationship;
  isPayer: boolean;
  receivesNotices: boolean;
  migratedFromGuardian: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** «Responsable de: …» en la ficha del paciente responsable. */
export interface ResponsibleForView {
  /** Id del vínculo. */
  id: string;
  patient: { id: string; firstName: string; lastName: string };
  relationship: ResponsibleRelationship;
  isPayer: boolean;
  receivesNotices: boolean;
}

export interface PatientResponsiblesSnapshot {
  patient: NoticePatientFields & { id: string };
  parties: ResponsiblePartyView[];
  /** Para la regla de destinatario (mismo orden que `parties`). */
  noticeResponsibles: NoticeResponsible[];
  responsibleFor: ResponsibleForView[];
  noticeLocation: NoticeLocation;
}

/** Datos de un contacto sin ficha (ya normalizados por el caso de uso). */
export interface ResponsibleContactFields {
  fullName: string;
  docType: DocType | null;
  docNumber: string | null;
  email: string | null;
  phone: string | null;
}

export interface CreateResponsiblePartyData {
  /** O un paciente responsable, o un contacto. */
  responsiblePatientId: string | null;
  contact: ResponsibleContactFields | null;
  relationship: ResponsibleRelationship;
  isPayer: boolean;
  receivesNotices: boolean;
}

/** Columnas que cambia la edición; ausente = no se toca. */
export interface UpdateResponsiblePartyData {
  relationship?: ResponsibleRelationship;
  isPayer?: boolean;
  receivesNotices?: boolean;
  contact?: Partial<ResponsibleContactFields>;
}

/**
 * Choque con un índice único al escribir (dos peticiones a la vez): la
 * comprobación previa del caso de uso no lo vio.
 */
export class ResponsiblePartyConflictError extends Error {
  constructor(readonly kind: 'PAYER' | 'DUPLICATE_PATIENT') {
    super(`responsible party conflict: ${kind}`);
  }
}

// Sin tenantId: sale del contexto de la petición y todo va bajo RLS.
export interface ResponsiblePartyRepository {
  /**
   * Responsables vivos del paciente y de quién es responsable, o null si el
   * paciente no existe (o es de otra clínica, o se retiró).
   */
  load(patientId: string): Promise<PatientResponsiblesSnapshot | null>;
  /** El paciente vivo de ESTA clínica (bajo RLS), o null. */
  findPatient(patientId: string): Promise<ResponsiblePatientSummary | null>;
  create(
    patientId: string,
    data: CreateResponsiblePartyData,
    createdById: string,
  ): Promise<ResponsiblePartyView>;
  /** null si el vínculo no existe (vivo) para ese paciente. */
  update(
    patientId: string,
    partyId: string,
    data: UpdateResponsiblePartyData,
  ): Promise<ResponsiblePartyView | null>;
  /** Lo quita en blando; false si no existía (vivo) para ese paciente. */
  remove(patientId: string, partyId: string): Promise<boolean>;
}
