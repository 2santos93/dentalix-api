import type { ConsentSignerType, DocType } from '@prisma/client';

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
}

export interface PatientConsent extends PatientConsentSummary {
  body: string;
  /** PNG en base64, sin prefijo `data:`. */
  patientSignature: string;
  professionalSignature: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/** El consentimiento con lo que necesita la vista imprimible. */
export interface PatientConsentDocument extends PatientConsent {
  clinic: { name: string; logoUrl: string | null };
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    docType: DocType;
    docNumber: string | null;
  };
  /** `true` si el hash guardado coincide con el recalculado al leer. */
  integrityOk: boolean;
}
