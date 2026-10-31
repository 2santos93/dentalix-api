import type {
  ConsentSignerType,
  SignatureRequestChannel,
  SignatureRequestType,
} from '@prisma/client';
import type { SignatureRequestStatus } from '../signature-request-status';

/**
 * Solicitud de firma a distancia (DX-243) tal como está en la base. El token y
 * el código solo existen como hash; `destination` es el email al que se
 * reenvía el código y nunca sale por la API (solo `destinationMasked`).
 */
export interface SignatureRequestRecord {
  id: string;
  tenantId: string;
  locationId: string;
  patientId: string;
  type: SignatureRequestType;
  channel: SignatureRequestChannel;
  templateId: string | null;
  templateVersion: number | null;
  treatmentPlanId: string | null;
  title: string;
  body: string;
  professionalUserId: string;
  professionalName: string;
  signerType: ConsentSignerType;
  signerName: string;
  signerDocument: string | null;
  destination: string;
  destinationMasked: string;
  tokenHash: string;
  codeHash: string | null;
  codeExpiresAt: Date | null;
  codeSentAt: Date | null;
  codeSendCount: number;
  failedAttempts: number;
  lockedAt: Date | null;
  sessionHash: string | null;
  sessionExpiresAt: Date | null;
  expiresAt: Date;
  openedAt: Date | null;
  verifiedAt: Date | null;
  signedAt: Date | null;
  revokedAt: Date | null;
  createdById: string;
  createdAt: Date;
}

/** Lo que ve la ficha: estado y evidencias, sin texto, destino ni hashes. */
export interface SignatureRequestSummary {
  id: string;
  patientId: string;
  type: SignatureRequestType;
  channel: SignatureRequestChannel;
  templateId: string | null;
  templateVersion: number | null;
  title: string;
  destinationMasked: string;
  signerType: ConsentSignerType;
  signerName: string;
  professionalUserId: string;
  professionalName: string;
  status: SignatureRequestStatus;
  sentAt: Date;
  sentByName: string | null;
  expiresAt: Date;
  openedAt: Date | null;
  verifiedAt: Date | null;
  lockedAt: Date | null;
  failedAttempts: number;
  signedAt: Date | null;
  revokedAt: Date | null;
  /** El consentimiento que produjo la firma del paciente. */
  consentId: string | null;
  /** IP desde la que firmó el paciente (evidencia). */
  signedIpAddress: string | null;
  /** Cuándo firmó el profesional en la app (Completo). */
  countersignedAt: Date | null;
}

/** Fila del listado: la solicitud con lo que hace falta para su estado. */
export interface SignatureRequestListRow {
  request: SignatureRequestRecord;
  sentByName: string | null;
  consent: {
    id: string;
    ipAddress: string | null;
    countersignedAt: Date | null;
  } | null;
}

/** Marca de la clínica y formato de la sede para la página pública. */
export interface PublicSignatureContext {
  request: SignatureRequestRecord;
  clinic: { name: string; logoUrl: string | null; primaryColor: string | null };
  location: {
    timeZone: string;
    locale: string | null;
    hourCycle: string | null;
  };
}
