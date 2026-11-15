import type { AppointmentStatus, DocumentType } from '@prisma/client';
import type { CertificateSnapshot } from '../certificate-snapshot';
import type {
  CertificateKind,
  CertificateTimesSource,
  RestValue,
} from '../certificate-rules';
import type { PatientCertificate } from '../patient-certificate';

export const PATIENT_CERTIFICATE_REPOSITORY = Symbol(
  'PATIENT_CERTIFICATE_REPOSITORY',
);

/** Un profesional tal como figura en el certificado (membresía + usuario). */
export interface CertificateProfessional {
  membershipId: string;
  name: string;
  license: string | null;
  specialty: string | null;
}

/** Todo lo que hace falta para emitir, leído en una transacción con RLS. */
export interface CertificateIssueContext {
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    docType: DocumentType;
    docTypeLabel: string | null;
    docNumber: string | null;
  };
  appointment: {
    id: string;
    locationId: string;
    providerId: string;
    status: AppointmentStatus;
    start: Date;
    end: Date;
    arrivedAt: Date | null;
    completedAt: Date | null;
  };
  location: {
    id: string;
    name: string;
    address: string | null;
    healthRegistrationNumber: string | null;
    showHealthRegistrationNumber: boolean;
    timeZone: string | null;
    locale: string | null;
    hourCycle: string | null;
  };
  clinic: {
    name: string;
    legalName: string | null;
    taxIdLabel: string | null;
    taxId: string | null;
  };
  settings: CertificateSettings;
  /** Membresía del profesional de la cita; null si ya no lo es. */
  provider: CertificateProfessional | null;
  /** Membresía de quien emite; null si no es miembro. */
  issuer: CertificateProfessional | null;
}

export type IssueContextResult =
  | { kind: 'OK'; context: CertificateIssueContext }
  | { kind: 'PATIENT_NOT_FOUND' }
  | { kind: 'APPOINTMENT_NOT_FOUND' };

export interface NewCertificateInput {
  patientId: string;
  appointmentId: string;
  locationId: string;
  professionalMembershipId: string;
  issuedById: string;
  kind: CertificateKind;
  attendedFrom: Date;
  attendedUntil: Date;
  timesSource: CertificateTimesSource;
  rest: RestValue | null;
  snapshot: CertificateSnapshot;
}

/** El PDF ya guardado en el almacén, listo para su fila de documentos. */
export interface ArchivedPdf {
  documentId: string;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  originalName: string;
}

/** Genera y guarda el PDF del certificado (con su número ya puesto). */
export type ArchivePdf = (
  certificate: PatientCertificate,
) => Promise<ArchivedPdf>;

export type IssueResult =
  | { kind: 'ISSUED'; certificate: PatientCertificate }
  | { kind: 'DUPLICATE'; number: number };

export type VoidResult =
  | { kind: 'VOIDED'; certificate: PatientCertificate }
  | { kind: 'NOT_FOUND' }
  | { kind: 'ALREADY_VOIDED' };

export interface CertificateSettings {
  restMaxDays: number;
  restPrintDiagnosis: boolean;
}

/** Cita atendida que admite certificado (selector de la ficha). */
export interface EligibleAppointment {
  id: string;
  locationId: string;
  locationName: string;
  start: Date;
  end: Date;
  providerName: string | null;
  /** Tipos con un certificado vivo (no anulado) de esta cita. */
  liveKinds: CertificateKind[];
}

export interface PatientCertificateRepository {
  loadIssueContext(
    patientId: string,
    appointmentId: string,
    issuerUserId: string,
  ): Promise<IssueContextResult>;
  /**
   * Inserta (el número lo pone la BD), genera y guarda el PDF con `archive`,
   * lo archiva en los documentos del paciente (REPORT) y lo enlaza. Todo en
   * una transacción: si algo falla, no queda certificado sin PDF.
   */
  issue(input: NewCertificateInput, archive: ArchivePdf): Promise<IssueResult>;
  /**
   * `locationIds`: sedes permitidas al usuario (DX-089); `undefined` = todas.
   * Un certificado de otra sede no sale (ni en la lista ni por id).
   * null = el paciente no existe en la clínica.
   */
  list(
    patientId: string,
    locationIds?: readonly string[],
  ): Promise<PatientCertificate[] | null>;
  get(
    patientId: string,
    id: string,
    locationIds?: readonly string[],
  ): Promise<PatientCertificate | null>;
  /**
   * Anula (una vez) con candado de la fila: `authorize` decide antes de
   * escribir (403). Anula el documento archivado y archiva el PDF anulado.
   */
  voidCertificate(
    patientId: string,
    id: string,
    locationIds: readonly string[] | undefined,
    actor: { userId: string; reason: string },
    authorize: (certificate: PatientCertificate) => void,
    archive: ArchivePdf,
  ): Promise<VoidResult>;
  /** null = el paciente no existe en la clínica. */
  eligibleAppointments(
    patientId: string,
    locationIds: readonly string[] | undefined,
    limit: number,
  ): Promise<EligibleAppointment[] | null>;
  /** Registro profesional de un miembro de la clínica (null sin él). */
  professionalLicense(userId: string): Promise<string | null>;
  getSettings(): Promise<CertificateSettings>;
  setSettings(
    next: CertificateSettings,
  ): Promise<{ before: CertificateSettings; after: CertificateSettings }>;
}
