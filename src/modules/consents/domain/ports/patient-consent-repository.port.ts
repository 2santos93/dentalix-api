import type { ConsentSignerType, DocType } from '@prisma/client';
import {
  PatientConsent,
  PatientConsentDocument,
  PatientConsentSummary,
} from '../entities/patient-consent.entity';

/** Lo que hace falta para resolver las variables de una plantilla. */
export interface ConsentSigningContext {
  patient: {
    firstName: string;
    lastName: string;
    docType: DocType;
    docNumber: string | null;
  };
  clinicName: string;
  professionalName: string;
  /** Zona de la sede activa o, sin ella, de la principal (R6): da la fecha. */
  timeZone: string;
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

  /** `null` si no existe, es de otro paciente o de otra clínica. */
  findDocument(
    patientId: string,
    id: string,
  ): Promise<Omit<PatientConsentDocument, 'integrityOk'> | null>;
}
