import type { ConsentSignerType, DocumentType } from '@prisma/client';
import {
  PatientConsent,
  PatientConsentSummary,
  StoredPatientConsentDocument,
} from '../entities/patient-consent.entity';

/** Lo que hace falta para resolver las variables de una plantilla. */
export interface ConsentSigningContext {
  patient: {
    firstName: string;
    lastName: string;
    docType: DocumentType;
    /** DX-327: nombre libre del documento (R7); null = sin etiqueta. */
    docTypeLabel: string | null;
    docNumber: string | null;
  };
  clinicName: string;
  professionalName: string;
  /** Zona de la sede activa o, sin ella, de la principal (R6): da la fecha. */
  timeZone: string;
  /**
   * Esa misma sede, con su formato y su reloj en crudo (G1-B): solo quien
   * pinta la fecha los exige (`requireLocationFormat`, 409 si faltan).
   */
  location: { id: string; locale: string | null; hourCycle: string | null };
  /**
   * `undefined` si no se pidió plan; `null` si se pidió y no es de este
   * paciente en esta clínica.
   */
  plan?: { id: string; items: { label: string; toothNumber: string }[] } | null;
}

export interface CreatePatientConsentRepoInput {
  patientId: string;
  templateId: string;
  templateVersion: number;
  treatmentPlanId: string | null;
  title: string;
  body: string;
  signerType: ConsentSignerType;
  signerName: string;
  signerDocument: string | null;
  professionalName: string;
  patientSignature: string;
  professionalSignature: string;
  contentHash: string;
  signedAt: Date;
  recordedById: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/** DX-243: lo que hace falta para la firma del profesional a distancia. */
export interface CountersignTarget {
  id: string;
  patientId: string;
  contentHash: string;
  /** null si se firmó en pantalla (ya lleva la firma del profesional). */
  remote: {
    /** Quien debe firmar: el profesional que nombra el texto. */
    professionalUserId: string;
    professionalName: string;
  } | null;
  countersigned: boolean;
}

export interface CreateCountersignatureRepoInput {
  patientId: string;
  consentId: string;
  professionalUserId: string;
  professionalName: string;
  professionalSignature: string;
  contentHash: string;
  signedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}

/** El insert chocó con la firma que otro guardó a la vez (índice único). */
export class AlreadyCountersignedError extends Error {
  constructor() {
    super('El consentimiento ya tiene la firma del profesional');
    this.name = 'AlreadyCountersignedError';
  }
}

export const PATIENT_CONSENT_REPOSITORY = Symbol('PATIENT_CONSENT_REPOSITORY');

export interface PatientConsentRepository {
  /**
   * `null` si el paciente no es de la clínica en contexto (RLS). El plan solo
   * se busca si se pasa `treatmentPlanId`, y siempre acotado al paciente.
   */
  loadSigningContext(params: {
    patientId: string;
    treatmentPlanId?: string;
    professionalUserId: string;
  }): Promise<ConsentSigningContext | null>;

  /**
   * Append-only: SIEMPRE inserta. No hay update ni delete en este puerto
   * (inmutabilidad a nivel de interfaz; la base también lo impide).
   */
  create(input: CreatePatientConsentRepoInput): Promise<PatientConsent>;

  /** Del paciente, más reciente primero, sin las firmas. */
  listByPatient(patientId: string): Promise<PatientConsentSummary[]>;

  /** DX-243: `null` si no existe, es de otro paciente o de otra clínica. */
  findCountersignTarget(
    patientId: string,
    id: string,
  ): Promise<CountersignTarget | null>;

  /**
   * DX-243: la firma del profesional de uno firmado a distancia. Append-only
   * (un INSERT; la base rechaza UPDATE y DELETE y una segunda firma). Lanza
   * `AlreadyCountersignedError` si otra petición la guardó antes.
   */
  countersign(
    input: CreateCountersignatureRepoInput,
  ): Promise<PatientConsentSummary>;

  /** `null` si no existe, es de otro paciente o de otra clínica. */
  findDocument(
    patientId: string,
    id: string,
  ): Promise<StoredPatientConsentDocument | null>;
}
