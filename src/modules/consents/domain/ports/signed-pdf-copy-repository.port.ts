import type { Prisma } from '@prisma/client';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';

export const SIGNED_PDF_COPY_REPOSITORY = Symbol('SIGNED_PDF_COPY_REPOSITORY');

/**
 * DX-443: a quién y desde dónde se envía la copia del PDF firmado de un
 * consentimiento a distancia (clínica del contexto, RLS).
 */
export interface SignedPdfCopyTarget {
  consentId: string;
  patientId: string;
  /** El PDF está archivado (READY); si no, no hay copia que enviar. */
  ready: boolean;
  /** false en los del barrido retroactivo: solo con «Reenviar copia». */
  notifyPatient: boolean;
  /** Email de la solicitud de firma: quien firmó (paciente o responsable). */
  destination: string;
  destinationMasked: string;
  signerType: 'PATIENT' | 'GUARDIAN';
  signerName: string;
  patientFirstName: string;
  clinicName: string;
  location: {
    id: string;
    timeZone: string | null;
    locale: string | null;
    hourCycle: string | null;
  };
}

export interface IssueSignedPdfCopyLinkInput {
  consentId: string;
  patientId: string;
  tokenHash: string;
  expiresAt: Date;
  /** null: el envío automático al quedar READY. */
  createdById: string | null;
  now: Date;
}

/** Un enlace buscado por el hash del token (RLS de la clínica del host). */
export interface SignedPdfCopyLinkRow {
  id: string;
  consentId: string;
  patientId: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

/** El documento archivado, para la URL firmada de la descarga. */
export interface SignedPdfCopyDownload {
  storageKey: string;
  originalName: string;
  mimeType: string;
}

export type ConsumeSignedPdfCopyOutcome =
  | { kind: 'CONSUMED'; download: SignedPdfCopyDownload }
  | { kind: 'USED' }
  | { kind: 'GONE' };

export interface ClinicBranding {
  name: string;
  primaryColor: string | null;
  logoUrl: string | null;
}

export interface SignedPdfCopyRepository {
  /** null si no existe en esta clínica, no es de este paciente o no es a distancia. */
  loadTarget(
    consentId: string,
    patientId?: string,
  ): Promise<SignedPdfCopyTarget | null>;
  /**
   * En UNA transacción: invalida el enlace vivo anterior (si lo hay) y crea
   * el nuevo. Devuelve su id y la hora del envío.
   */
  issueLink(input: IssueSignedPdfCopyLinkInput): Promise<{ id: string }>;
  findLinkByTokenHash(tokenHash: string): Promise<SignedPdfCopyLinkRow | null>;
  /**
   * Gasta el enlace (UPDATE condicional: sin usar, sin invalidar y sin
   * caducar) y, en la misma transacción, deja el evento de auditoría EXPORT
   * de CONSENT con origen PUBLIC_LINK. Dos descargas a la vez: una gana.
   */
  consumeLink(
    linkId: string,
    now: Date,
    meta: AuditRequestMeta,
  ): Promise<ConsumeSignedPdfCopyOutcome>;
  findClinicBranding(): Promise<ClinicBranding | null>;
}

export const SIGNED_PDF_COPY_SCHEDULER = Symbol('SIGNED_PDF_COPY_SCHEDULER');

/** Encola el envío automático en la transacción que archiva el PDF (outbox). */
export interface SignedPdfCopyScheduler {
  schedule(tx: Prisma.TransactionClient, consentId: string): Promise<void>;
}

/** Barrido retroactivo (DX-443): consentimientos completos sin PDF. */
export interface SignedConsentPdfBackfillRepository {
  tenantIds(): Promise<string[]>;
  /**
   * Hasta `limit` consentimientos completos a distancia de la clínica SIN
   * fila en signed_consent_pdfs: crea su estado PENDING (sin aviso al
   * paciente) y encola su generación en la misma transacción. Uno que ya
   * tenga fila (otra réplica, la firma en curso) se salta: idempotente.
   */
  backfill(
    tenantId: string,
    limit: number,
    enqueue: (tx: Prisma.TransactionClient, consentId: string) => Promise<void>,
  ): Promise<number>;
}

export const SIGNED_CONSENT_PDF_BACKFILL_REPOSITORY = Symbol(
  'SIGNED_CONSENT_PDF_BACKFILL_REPOSITORY',
);
