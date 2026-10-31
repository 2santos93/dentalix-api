import type { Prisma, SignedConsentPdfStatus } from '@prisma/client';
import type { SignedConsentPdfSource } from '../signed-consent-pdf';

export const SIGNED_CONSENT_PDF_REPOSITORY = Symbol(
  'SIGNED_CONSENT_PDF_REPOSITORY',
);

/** Lo que el trabajo de la cola necesita de un consentimiento (DX-422). */
export interface SignedConsentPdfJobSource {
  consentId: string;
  patientId: string;
  /** Sede desde la que se envió: la del documento archivado. */
  locationId: string;
  /** El profesional que lo completó: autor del documento archivado. */
  professionalUserId: string;
  status: SignedConsentPdfStatus;
  /** DX-443: al archivarlo, enviar la copia al paciente (no en el retroactivo). */
  notifyPatient: boolean;
  /** null si aún no está completo (falta la firma del profesional). */
  source: SignedConsentPdfSource | null;
}

/** El documento ya guardado en el almacén, para su fila en la ficha. */
export interface ArchiveSignedConsentPdfInput {
  consentId: string;
  patientId: string;
  documentId: string;
  locationId: string;
  uploadedById: string;
  originalName: string;
  mimeType: 'application/pdf';
  sizeBytes: number;
  sha256: string;
  storageKey: string;
}

export type RetrySignedConsentPdfOutcome =
  'RETRYING' | 'NOT_FOUND' | 'NOT_FAILED';

/**
 * Estado del PDF firmado (`signed_consent_pdfs`) bajo la RLS del tenant del
 * contexto. Sin DELETE: una fila READY queda congelada (trigger).
 */
export interface SignedConsentPdfRepository {
  /** null si el consentimiento no existe en esta clínica o no es a distancia. */
  loadForJob(consentId: string): Promise<SignedConsentPdfJobSource | null>;
  /**
   * En UNA transacción: la fila del documento del paciente (SIGNED_CONSENT,
   * inalterable) y el estado a READY con su id. `ALREADY_READY` si otro
   * intento lo archivó antes (y no se crea nada). DX-443: `onArchived` corre
   * en esa misma transacción (encolar la copia al paciente: outbox).
   */
  archive(
    input: ArchiveSignedConsentPdfInput,
    onArchived?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<'ARCHIVED' | 'ALREADY_READY'>;
  /** Cuenta el intento y deja el código; `final` ⇒ FAILED. */
  recordFailure(
    consentId: string,
    failure: { code: string; final: boolean },
  ): Promise<void>;
}

/** Lo que usa la ficha para reintentar uno FAILED (con la cola en su tx). */
export interface SignedConsentPdfRetryRepository {
  /**
   * `authorize` recibe la sede desde la que se envió a firmar (NULL si el
   * consentimiento no tuvo envío a distancia) y lanza para abortar antes de
   * cambiar el estado (SEC-060).
   */
  requestRetry(
    patientId: string,
    consentId: string,
    authorize: (locationId: string | null) => void,
    enqueue: (tx: Prisma.TransactionClient, attempt: number) => Promise<void>,
  ): Promise<RetrySignedConsentPdfOutcome>;
}

export const SIGNED_CONSENT_PDF_SCHEDULER = Symbol(
  'SIGNED_CONSENT_PDF_SCHEDULER',
);

/** Encola la generación del PDF firmado en la transacción de negocio (outbox). */
export interface SignedConsentPdfScheduler {
  schedule(tx: Prisma.TransactionClient, consentId: string): Promise<void>;
}
