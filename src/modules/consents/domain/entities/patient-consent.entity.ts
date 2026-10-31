import type {
  ConsentSignerType,
  DocumentType,
  SignatureRequestChannel,
} from '@prisma/client';

/**
 * DX-243: evidencias congeladas de una firma del paciente a distancia (por
 * enlace con código). `professionalUserId` es quien debe firmar después.
 */
export interface RemoteConsentEvidence {
  signatureRequestId: string;
  channel: SignatureRequestChannel;
  destinationMasked: string;
  sentAt: Date;
  openedAt: Date;
  verifiedAt: Date;
  professionalUserId: string;
}

/**
 * Consentimiento FIRMADO (DX-006): foto congelada del documento. No hay forma
 * de modificarlo ni de borrarlo (ni puerto, ni endpoint, ni la base lo deja).
 * El listado no trae las firmas (pesan); el detalle sí.
 */
export interface PatientConsentSummary {
  id: string;
  tenantId: string;
  patientId: string;
  templateId: string;
  templateVersion: number;
  treatmentPlanId: string | null;
  title: string;
  signerType: ConsentSignerType;
  signerName: string;
  signerDocument: string | null;
  professionalName: string;
  contentHash: string;
  signedAt: Date;
  recordedById: string;
  /** DX-243: null si se firmó en pantalla. */
  remote: RemoteConsentEvidence | null;
  /**
   * Cuándo firmó el profesional: la misma hora en pantalla; a distancia, la
   * de su firma posterior en la app, o null si aún falta.
   */
  professionalSignedAt: Date | null;
  /** Solo cuenta como válido con las dos firmas (DX-243). */
  complete: boolean;
}

export interface PatientConsent extends PatientConsentSummary {
  body: string;
  /** PNG en base64, sin prefijo `data:`. */
  patientSignature: string;
  /** null en uno firmado a distancia hasta que firma el profesional. */
  professionalSignature: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/** DX-243: la firma del profesional que completó uno firmado a distancia. */
export interface StoredCountersignature {
  professionalName: string;
  professionalSignature: string;
  contentHash: string;
  signedAt: Date;
}

/** El paciente VIVO de la cabecera imprimible (no está sellado). */
export interface ConsentDocumentPatient {
  id: string;
  firstName: string;
  lastName: string;
  docType: DocumentType;
  /** DX-327: nombre libre del documento (R7); null = sin etiqueta. */
  docTypeLabel: string | null;
  docNumber: string | null;
}

/** El consentimiento con lo que necesita la vista imprimible. */
export interface PatientConsentDocument extends PatientConsent {
  clinic: { name: string; logoUrl: string | null };
  /** `docTypeName`: el nombre visible de hoy (R17), en vivo como la cabecera. */
  patient: ConsentDocumentPatient & { docTypeName: string };
  /** `true` si el hash guardado coincide con el recalculado al leer. */
  integrityOk: boolean;
}

/** Lo que lee el repositorio; el caso de uso añade el nombre y la integridad. */
export type StoredPatientConsentDocument = Omit<
  PatientConsentDocument,
  'integrityOk' | 'patient'
> & {
  patient: ConsentDocumentPatient;
  /** La firma del profesional a distancia con su propio hash (DX-243). */
  countersignature: StoredCountersignature | null;
};
