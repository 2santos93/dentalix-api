import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  FILE_STORAGE,
  type FileStoragePort,
} from '../../../shared/storage/file-storage.port';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { JobQueue } from '../../jobs/application/job-queue.service';
import { JobRegistry } from '../../jobs/application/job-registry';
import type { JobContext, JobPayload } from '../../jobs/domain/job';
import { storageKeyFor } from '../../patient-documents/domain/document-rules';
import {
  SIGNED_CONSENT_PDF_REPOSITORY,
  type SignedConsentPdfRepository,
  type SignedConsentPdfRetryRepository,
  type SignedConsentPdfScheduler,
} from '../domain/ports/signed-consent-pdf-repository.port';
import {
  SignedConsentPdfSourceError,
  buildSignedConsentPdfModel,
  signedConsentPdfErrorCode,
  signedConsentPdfFileName,
} from '../domain/signed-consent-pdf';
import {
  SIGNED_CONSENT_PDF_RENDERER,
  type SignedConsentPdfRenderer,
} from '../infrastructure/pdf/signed-consent-pdf.renderer';

/** Trabajo de la cola (DX-085) que genera y archiva el PDF firmado. */
export const SIGNED_CONSENT_PDF_JOB = 'consents.signed-pdf';
/** Intentos con backoff exponencial antes de quedar FAILED en la ficha. */
export const SIGNED_CONSENT_PDF_MAX_ATTEMPTS = 6;

/** Clave de idempotencia por clínica: una generación por consentimiento (y por reintento manual). */
export function signedConsentPdfJobKey(consentId: string, retry = 0): string {
  return retry === 0
    ? `consents.signed-pdf:${consentId}`
    : `consents.signed-pdf:${consentId}:retry-${retry}`;
}

/** Códigos de Prisma de conexión perdida (no de la consulta), como DX-151. */
const CONNECTION_LOST_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017']);

function isConnectionLostError(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      CONNECTION_LOST_CODES.has(error.code)) ||
    error instanceof Prisma.PrismaClientInitializationError
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DX-422: genera en el servidor el PDF del consentimiento firmado a distancia
 * (texto congelado, firma de quien firmó y del profesional, página de
 * evidencias) y lo archiva en los documentos del paciente. Corre en la cola
 * con el tenant del trabajo; el payload solo lleva el id. Lo relee todo de la
 * BD y comprueba los hashes guardados antes de pintar.
 *
 * Errores: los del ORIGEN (registro alterado, no completo, sede sin zona o
 * formato, texto que la fuente no pinta) son definitivos: FAILED sin
 * reintento. Los demás (almacén, BD, render) se cuentan y se relanzan para
 * que la cola reintente; en el último intento queda FAILED y la ficha ofrece
 * reintentar. Ni en el log ni en la fila va nada clínico: ids y códigos.
 */
@Injectable()
export class GenerateSignedConsentPdf {
  private readonly logger = new Logger('SignedConsentPdf');

  constructor(
    @Inject(SIGNED_CONSENT_PDF_REPOSITORY)
    private readonly repo: SignedConsentPdfRepository,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
    @Inject(SIGNED_CONSENT_PDF_RENDERER)
    private readonly renderer: SignedConsentPdfRenderer,
    private readonly tenantContext: TenantContextService,
  ) {}

  async handle(payload: JobPayload, context: JobContext): Promise<void> {
    const { consentId } = payload;
    if (typeof consentId !== 'string' || !UUID.test(consentId)) {
      throw new Error(`${SIGNED_CONSENT_PDF_JOB}: payload inválido`);
    }
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error(`${SIGNED_CONSENT_PDF_JOB}: sin clínica`);

    const job = await this.repo.loadForJob(consentId);
    if (!job || job.status === 'READY') return;

    let storageKey: string | null = null;
    try {
      if (!job.source) throw new SignedConsentPdfSourceError('NOT_COMPLETE');
      const model = buildSignedConsentPdfModel(job.source);
      const pdf = await this.renderer.render(model);
      if (context.signal.aborted) throw new Error('Intento abortado');
      const documentId = randomUUID();
      storageKey = storageKeyFor(tenantId, documentId, 'application/pdf');
      await this.storage.save(storageKey, pdf, 'application/pdf');
      const outcome = await this.repo.archive({
        consentId,
        patientId: job.patientId,
        documentId,
        locationId: job.locationId,
        uploadedById: job.professionalUserId,
        originalName: signedConsentPdfFileName(
          model.title,
          model.completedAt,
          // buildSignedConsentPdfModel ya exigió la zona.
          job.source.location.timeZone ?? 'UTC',
        ),
        mimeType: 'application/pdf',
        sizeBytes: pdf.length,
        sha256: createHash('sha256').update(pdf).digest('hex'),
        storageKey,
      });
      // Otro intento lo archivó antes: este objeto no tiene fila.
      if (outcome === 'ALREADY_READY') await this.discard(storageKey);
    } catch (error) {
      // Con la conexión perdida el INSERT pudo confirmarse: se conserva el
      // objeto (a lo sumo, un huérfano) en vez de dejar una fila sin fichero.
      if (storageKey && !isConnectionLostError(error)) {
        await this.discard(storageKey);
      }
      const definitive = error instanceof SignedConsentPdfSourceError;
      const code = signedConsentPdfErrorCode(error);
      await this.repo.recordFailure(consentId, {
        code,
        final: definitive || context.attempt >= context.maxAttempts,
      });
      this.logger.warn(
        `PDF firmado no generado (consentId=${consentId}, intento=${context.attempt}/${context.maxAttempts}, code=${code})`,
      );
      if (definitive) return;
      throw error;
    }
  }

  /** El objeto sin fila no es alcanzable por la API; borrarlo es higiene. */
  private async discard(storageKey: string): Promise<void> {
    try {
      // Excepción justificada al borrado blando: borra el OBJETO del almacén
      // de una generación cuya fila no se creó, no una fila de la BD.
      // eslint-disable-next-line no-restricted-syntax
      await this.storage.delete(storageKey);
    } catch (error) {
      this.logger.warn(
        `No se pudo borrar el PDF de una generación fallida (error=${error instanceof Error ? error.name : 'NonError'})`,
      );
    }
  }
}

/** Encola en la cola de DX-085, dentro de la transacción de negocio. */
@Injectable()
export class SignedConsentPdfQueue implements SignedConsentPdfScheduler {
  constructor(private readonly jobs: JobQueue) {}

  async schedule(
    tx: Prisma.TransactionClient,
    consentId: string,
  ): Promise<void> {
    await this.jobs.enqueue(
      SIGNED_CONSENT_PDF_JOB,
      { consentId },
      { tx, idempotencyKey: signedConsentPdfJobKey(consentId) },
    );
  }

  /** Reintento manual: clave nueva (la anterior sigue en la cola como FAILED). */
  async retry(
    tx: Prisma.TransactionClient,
    consentId: string,
    attempt: number,
  ): Promise<void> {
    await this.jobs.enqueue(
      SIGNED_CONSENT_PDF_JOB,
      { consentId },
      { tx, idempotencyKey: signedConsentPdfJobKey(consentId, attempt) },
    );
  }
}

export const SIGNED_PDF_NOT_FOUND_MESSAGE = 'Consentimiento no encontrado';
export const SIGNED_PDF_NOT_FAILED_MESSAGE =
  'El PDF firmado ya está archivado o se está generando.';

/**
 * «Reintentar» desde la ficha cuando la cola agotó los intentos (FAILED):
 * vuelve a PENDING y encola otro trabajo, en una transacción. 404 si el
 * consentimiento no es de este paciente en esta clínica (RLS); 409 si no está
 * en error.
 */
@Injectable()
export class RetrySignedConsentPdfUseCase {
  constructor(
    @Inject(SIGNED_CONSENT_PDF_REPOSITORY)
    private readonly repo: SignedConsentPdfRetryRepository,
    @Inject(SignedConsentPdfQueue)
    private readonly queue: Pick<SignedConsentPdfQueue, 'retry'>,
  ) {}

  async execute(
    patientId: string,
    consentId: string,
  ): Promise<{ status: 'PENDING' }> {
    const outcome = await this.repo.requestRetry(
      patientId,
      consentId,
      (tx, attempt) => this.queue.retry(tx, consentId, attempt),
    );
    if (outcome === 'NOT_FOUND') {
      throw new NotFoundException(SIGNED_PDF_NOT_FOUND_MESSAGE);
    }
    if (outcome === 'NOT_FAILED') {
      throw new ConflictException(SIGNED_PDF_NOT_FAILED_MESSAGE);
    }
    return { status: 'PENDING' };
  }
}

/** Registra el trabajo en la cola (antes de que el worker arranque). */
@Injectable()
export class SignedConsentPdfJobs implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly generate: GenerateSignedConsentPdf,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: SIGNED_CONSENT_PDF_JOB,
      maxAttempts: SIGNED_CONSENT_PDF_MAX_ATTEMPTS,
      handle: (payload, context) => this.generate.handle(payload, context),
    });
  }
}
