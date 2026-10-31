import {
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  FILE_STORAGE,
  type FileStoragePort,
} from '../../../shared/storage/file-storage.port';
import { requireLocationFormat } from '../../../shared/locations/location-regional';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { TenantLinkBaseService } from '../../../shared/tenancy/tenant-link-base.service';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import { JobQueue } from '../../jobs/application/job-queue.service';
import { JobRegistry } from '../../jobs/application/job-registry';
import type { JobPayload } from '../../jobs/domain/job';
import { EmailOutbox } from '../../notifications/email/application/email-outbox.service';
import type { SignedConsentCopyEmailVars } from '../../notifications/email/domain/email-message';
import { EmailQuotaExceededError } from '../../notifications/email/domain/email-quota-exceeded.error';
import {
  SIGNED_CONSENT_PDF_BACKFILL_REPOSITORY,
  SIGNED_PDF_COPY_REPOSITORY,
  type ClinicBranding,
  type SignedConsentPdfBackfillRepository,
  type SignedPdfCopyRepository,
  type SignedPdfCopyScheduler,
  type SignedPdfCopyTarget,
} from '../domain/ports/signed-pdf-copy-repository.port';
import {
  SIGNED_PDF_COPY_CONFIG,
  SIGNED_PDF_COPY_MESSAGES,
  SIGNED_PDF_COPY_NOT_FOUND_MESSAGE,
  SIGNED_PDF_COPY_USED_CODE,
  SIGNED_PDF_COPY_USED_MESSAGE,
  buildSignedPdfCopyUrl,
  generateSignedPdfCopyToken,
  hashSignedPdfCopyToken,
  isWellFormedSignedPdfCopyToken,
  publicSignedPdfCopyState,
  signedPdfCopyExpiresAt,
  type SignedPdfCopyConfig,
} from '../domain/signed-pdf-copy-link';
import {
  CONSENT_CLOCK,
  type ConsentClock,
} from './use-cases/patient-consents.use-cases';
import { SignedConsentPdfQueue } from './signed-consent-pdf.service';

/** Trabajo de la cola (DX-085) que envía la copia al quedar READY. */
export const SIGNED_PDF_COPY_JOB = 'consents.signed-pdf-copy';
export const SIGNED_PDF_COPY_MAX_ATTEMPTS = 6;

/** Una sola copia automática por consentimiento. */
export function signedPdfCopyJobKey(consentId: string): string {
  return `consents.signed-pdf-copy:${consentId}`;
}

/** Barrido retroactivo (DX-443): consentimientos completos sin PDF. */
export const SIGNED_PDF_BACKFILL_JOB = 'consents.signed-pdf-backfill';
export const SIGNED_PDF_BACKFILL_SCHEDULE =
  'consents.signed-pdf-backfill.every-fifteen-minutes';
export const SIGNED_PDF_BACKFILL_CRON = '*/15 * * * *';
/** Tope por clínica y pasada; lo que quede lo recoge la siguiente. */
export const SIGNED_PDF_BACKFILL_BATCH = 100;

/** La URL firmada de la descarga pública: lo justo para que el navegador la abra. */
export const SIGNED_PDF_COPY_DOWNLOAD_TTL_SECONDS = 60;

export const SIGNED_PDF_COPY_NOT_READY_MESSAGE =
  'El PDF firmado todavía no está archivado: la copia se envía cuando esté listo.';
export const SIGNED_PDF_COPY_NO_LINK_HOST_MESSAGE =
  'No se pudo armar el enlace de la clínica: revisa su subdominio.';
const CONSENT_NOT_FOUND_MESSAGE = 'Consentimiento no encontrado';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SIGNED_PDF_COPY_EMAIL_SENDER = Symbol(
  'SIGNED_PDF_COPY_EMAIL_SENDER',
);

/** El email de la copia por el outbox de DX-088. */
export interface SignedPdfCopyEmailSender {
  /** Topes del outbox por destinatario y clínica (solo el reenvío manual). */
  assertCanSend(to: string): Promise<void>;
  send(input: {
    to: string;
    referenceId: string;
    vars: SignedConsentCopyEmailVars;
  }): Promise<void>;
}

function tenantIdOf(tenantContext: Pick<TenantContextService, 'getTenantId'>) {
  const tenantId = tenantContext.getTenantId();
  if (!tenantId) throw new Error('No tenant in context');
  return tenantId;
}

/** Adaptador del outbox, como el de la firma a distancia (DX-243). */
@Injectable()
export class OutboxSignedPdfCopyEmailSender implements SignedPdfCopyEmailSender {
  constructor(
    private readonly outbox: EmailOutbox,
    private readonly tenantContext: TenantContextService,
  ) {}

  async assertCanSend(to: string): Promise<void> {
    try {
      await this.outbox.assertWithinQuota(tenantIdOf(this.tenantContext), to);
    } catch (err) {
      if (err instanceof EmailQuotaExceededError) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            error: 'Too Many Requests',
            message: err.message,
            retryAfterSeconds: err.retryAfterSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw err;
    }
  }

  async send(input: {
    to: string;
    referenceId: string;
    vars: SignedConsentCopyEmailVars;
  }): Promise<void> {
    await this.outbox.enqueue({
      tenantId: tenantIdOf(this.tenantContext),
      to: input.to,
      template: 'signed-consent-copy',
      vars: input.vars,
      referenceId: input.referenceId,
    });
  }
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/**
 * Crea el enlace (solo su hash: el token va únicamente en el email),
 * invalidando el anterior, y encola el email sin nada clínico. `null` si no
 * hay un host seguro para el enlace (TenantLinkBaseService, SEC-033): no se
 * crea nada.
 */
@Injectable()
export class SignedPdfCopySender {
  constructor(
    @Inject(SIGNED_PDF_COPY_REPOSITORY)
    private readonly repo: Pick<SignedPdfCopyRepository, 'issueLink'>,
    @Inject(SIGNED_PDF_COPY_EMAIL_SENDER)
    private readonly email: Pick<SignedPdfCopyEmailSender, 'send'>,
    @Inject(TenantLinkBaseService)
    private readonly linkBase: Pick<TenantLinkBaseService, 'forTenant'>,
    @Inject(TenantContextService)
    private readonly tenantContext: Pick<TenantContextService, 'getTenantId'>,
    @Inject(SIGNED_PDF_COPY_CONFIG)
    private readonly config: SignedPdfCopyConfig,
    @Inject(CONSENT_CLOCK) private readonly clock: ConsentClock,
  ) {}

  async send(
    target: SignedPdfCopyTarget,
    createdById: string | null,
    requestHost?: string,
  ): Promise<{ sentAt: Date; expiresAt: Date } | null> {
    const tenantId = tenantIdOf(this.tenantContext);
    const base = await this.linkBase.forTenant(tenantId, requestHost);
    if (!base) return null;
    // Formato de la sede del envío: sin él, 409 (nunca otro formato).
    const format = requireLocationFormat(target.location);
    const timeZone = target.location.timeZone ?? 'UTC';
    const now = this.clock();
    const expiresAt = signedPdfCopyExpiresAt(now, this.config.ttlHours);
    const token = generateSignedPdfCopyToken();
    const link = await this.repo.issueLink({
      consentId: target.consentId,
      patientId: target.patientId,
      tokenHash: hashSignedPdfCopyToken(token),
      expiresAt,
      createdById,
      now,
    });
    await this.email.send({
      to: target.destination,
      referenceId: link.id,
      vars: {
        recipientFirstName: firstName(target.signerName),
        patientFirstName:
          target.signerType === 'GUARDIAN'
            ? firstName(target.patientFirstName)
            : null,
        clinicName: target.clinicName,
        url: buildSignedPdfCopyUrl(base, token),
        expiresAtLabel: format.longDateTime(expiresAt, timeZone),
      },
    });
    return { sentAt: now, expiresAt };
  }
}

/**
 * El trabajo `consents.signed-pdf-copy`: lo encola, en su misma transacción,
 * el archivo del PDF (READY). Corre con la clínica del trabajo y relee todo.
 * Los del barrido retroactivo (`notifyPatient = false`) no escriben al
 * paciente. Sin host seguro no se reintenta (no se arreglaría solo).
 */
@Injectable()
export class SendSignedPdfCopyJob {
  private readonly logger = new Logger('SignedPdfCopy');

  constructor(
    @Inject(SIGNED_PDF_COPY_REPOSITORY)
    private readonly repo: Pick<SignedPdfCopyRepository, 'loadTarget'>,
    @Inject(SignedPdfCopySender)
    private readonly sender: Pick<SignedPdfCopySender, 'send'>,
  ) {}

  async handle(payload: JobPayload): Promise<void> {
    const { consentId } = payload;
    if (typeof consentId !== 'string' || !UUID.test(consentId)) {
      throw new Error(`${SIGNED_PDF_COPY_JOB}: payload inválido`);
    }
    const target = await this.repo.loadTarget(consentId);
    if (!target?.ready || !target.notifyPatient) return;
    const sent = await this.sender.send(target, null);
    // Solo ids: ni el email ni el nombre van al log.
    this.logger.log({
      event: sent
        ? 'consents.signed_pdf_copy.sent'
        : 'consents.signed_pdf_copy.no_link_host',
      consentId,
    });
  }
}

/** Respuesta de «Reenviar copia». */
export interface SignedPdfCopyResent {
  sentAt: Date;
  expiresAt: Date;
  destinationMasked: string;
}

/**
 * «Reenviar copia» desde la ficha: enlace nuevo (el anterior deja de servir
 * en la misma transacción) y email. 404 si el consentimiento no es de este
 * paciente en esta clínica; 409 si el PDF no está archivado; 429 con el tope
 * del outbox ANTES de tocar nada.
 */
@Injectable()
export class ResendSignedPdfCopyUseCase {
  constructor(
    @Inject(SIGNED_PDF_COPY_REPOSITORY)
    private readonly repo: Pick<SignedPdfCopyRepository, 'loadTarget'>,
    @Inject(SignedPdfCopySender)
    private readonly sender: Pick<SignedPdfCopySender, 'send'>,
    @Inject(SIGNED_PDF_COPY_EMAIL_SENDER)
    private readonly email: Pick<SignedPdfCopyEmailSender, 'assertCanSend'>,
  ) {}

  async execute(
    patientId: string,
    consentId: string,
    userId: string,
    requestHost?: string,
  ): Promise<SignedPdfCopyResent> {
    const target = await this.repo.loadTarget(consentId, patientId);
    if (!target) throw new NotFoundException(CONSENT_NOT_FOUND_MESSAGE);
    if (!target.ready) {
      throw new ConflictException(SIGNED_PDF_COPY_NOT_READY_MESSAGE);
    }
    await this.email.assertCanSend(target.destination);
    const sent = await this.sender.send(target, userId, requestHost);
    if (!sent)
      throw new ConflictException(SIGNED_PDF_COPY_NO_LINK_HOST_MESSAGE);
    return { ...sent, destinationMasked: target.destinationMasked };
  }
}

/** Lo que ve quien abre el enlace: nada clínico (ni el título del documento). */
export interface PublicSignedPdfCopyView {
  state: 'AVAILABLE' | 'USED';
  message: string;
  clinic: ClinicBranding | null;
  expiresAt: Date;
}

/**
 * Búsqueda común de las rutas públicas. El tenant sale SOLO del host
 * (DX-207); la RLS hace invisible un token de otra clínica: el mismo 404 que
 * uno inventado, caducado o invalidado al reenviar.
 */
async function findLink(
  tenantContext: Pick<TenantContextService, 'getTenantId'>,
  repo: Pick<SignedPdfCopyRepository, 'findLinkByTokenHash'>,
  token: string,
  now: Date,
) {
  if (!tenantContext.getTenantId() || !isWellFormedSignedPdfCopyToken(token)) {
    throw new NotFoundException(SIGNED_PDF_COPY_NOT_FOUND_MESSAGE);
  }
  const link = await repo.findLinkByTokenHash(hashSignedPdfCopyToken(token));
  const state = link ? publicSignedPdfCopyState(link, now) : 'GONE';
  if (!link || state === 'GONE') {
    throw new NotFoundException(SIGNED_PDF_COPY_NOT_FOUND_MESSAGE);
  }
  return { link, state };
}

function linkUsed(): GoneException {
  return new GoneException({
    statusCode: HttpStatus.GONE,
    error: 'Gone',
    code: SIGNED_PDF_COPY_USED_CODE,
    message: SIGNED_PDF_COPY_USED_MESSAGE,
  });
}

/** Abrir el enlace: SOLO LECTURA (los previsualizadores del correo lo abren solos). */
@Injectable()
export class GetPublicSignedPdfCopyUseCase {
  constructor(
    @Inject(SIGNED_PDF_COPY_REPOSITORY)
    private readonly repo: Pick<
      SignedPdfCopyRepository,
      'findLinkByTokenHash' | 'findClinicBranding'
    >,
    @Inject(TenantContextService)
    private readonly tenantContext: Pick<TenantContextService, 'getTenantId'>,
    @Inject(CONSENT_CLOCK) private readonly clock: ConsentClock,
  ) {}

  async execute(token: string): Promise<PublicSignedPdfCopyView> {
    const { link, state } = await findLink(
      this.tenantContext,
      this.repo,
      token,
      this.clock(),
    );
    const visible = state === 'USED' ? 'USED' : 'AVAILABLE';
    return {
      state: visible,
      message: SIGNED_PDF_COPY_MESSAGES[visible],
      clinic: await this.repo.findClinicBranding(),
      expiresAt: link.expiresAt,
    };
  }
}

export interface SignedPdfCopyDownloadUrl {
  url: string;
  expiresAt: Date;
  fileName: string;
}

/**
 * Descargar: gasta el enlace (una vez; auditado como EXPORT de CONSENT con
 * origen PUBLIC_LINK) y devuelve una URL firmada de 60 s del PDF archivado,
 * como attachment. Ya usado: 410 «enlace usado».
 */
@Injectable()
export class DownloadSignedPdfCopyUseCase {
  constructor(
    @Inject(SIGNED_PDF_COPY_REPOSITORY)
    private readonly repo: Pick<
      SignedPdfCopyRepository,
      'findLinkByTokenHash' | 'consumeLink'
    >,
    @Inject(TenantContextService)
    private readonly tenantContext: Pick<TenantContextService, 'getTenantId'>,
    @Inject(CONSENT_CLOCK) private readonly clock: ConsentClock,
    @Inject(FILE_STORAGE)
    private readonly storage: Pick<FileStoragePort, 'getSignedUrl'>,
  ) {}

  async execute(
    token: string,
    meta: AuditRequestMeta,
  ): Promise<SignedPdfCopyDownloadUrl> {
    const now = this.clock();
    const { link, state } = await findLink(
      this.tenantContext,
      this.repo,
      token,
      now,
    );
    if (state === 'USED') throw linkUsed();
    const outcome = await this.repo.consumeLink(link.id, now, meta);
    if (outcome.kind === 'USED') throw linkUsed();
    if (outcome.kind === 'GONE') {
      throw new NotFoundException(SIGNED_PDF_COPY_NOT_FOUND_MESSAGE);
    }
    const { download } = outcome;
    const url = await this.storage.getSignedUrl(
      download.storageKey,
      SIGNED_PDF_COPY_DOWNLOAD_TTL_SECONDS,
      {
        disposition: 'attachment',
        filename: download.originalName,
        contentType: download.mimeType,
      },
    );
    return {
      url,
      expiresAt: new Date(
        now.getTime() + SIGNED_PDF_COPY_DOWNLOAD_TTL_SECONDS * 1000,
      ),
      fileName: download.originalName,
    };
  }
}

/** Encola la copia automática en la transacción que archiva el PDF (outbox). */
@Injectable()
export class SignedPdfCopyQueue implements SignedPdfCopyScheduler {
  constructor(private readonly jobs: JobQueue) {}

  async schedule(
    tx: Prisma.TransactionClient,
    consentId: string,
  ): Promise<void> {
    await this.jobs.enqueue(
      SIGNED_PDF_COPY_JOB,
      { consentId },
      { tx, idempotencyKey: signedPdfCopyJobKey(consentId) },
    );
  }
}

/**
 * DX-443: los consentimientos completos a distancia SIN PDF (completados
 * antes de DX-422, o en una réplica antigua durante el despliegue) reciben su
 * estado PENDING y su trabajo de generación, por lotes y por clínica. La
 * clave de idempotencia es la misma que la de la firma: repetirlo no duplica
 * nada. No escribe al paciente (`notifyPatient = false`).
 */
@Injectable()
export class BackfillSignedConsentPdfs {
  private readonly logger = new Logger('SignedConsentPdf');

  constructor(
    @Inject(SIGNED_CONSENT_PDF_BACKFILL_REPOSITORY)
    private readonly repo: SignedConsentPdfBackfillRepository,
    @Inject(SignedConsentPdfQueue)
    private readonly queue: Pick<SignedConsentPdfQueue, 'schedule'>,
  ) {}

  /** Todas las clínicas; falla al final si alguna falló (la cola reintenta). */
  async run(): Promise<{ queued: number }> {
    let queued = 0;
    let failed = 0;
    for (const tenantId of await this.repo.tenantIds()) {
      try {
        queued += await this.repo.backfill(
          tenantId,
          SIGNED_PDF_BACKFILL_BATCH,
          (tx, consentId) => this.queue.schedule(tx, consentId),
        );
      } catch (error) {
        failed += 1;
        this.logger.warn({
          event: 'consents.signed_pdf_backfill_failed',
          tenantId,
          error: error instanceof Error ? error.name : 'Error',
        });
      }
    }
    if (queued > 0 || failed > 0) {
      this.logger.log({
        event: 'consents.signed_pdf_backfill',
        queued,
        failed,
      });
    }
    if (failed > 0) {
      throw new Error(`Barrido de PDF firmados falló en ${failed} clínica(s)`);
    }
    return { queued };
  }
}

/** Registra el envío de la copia y el barrido retroactivo en la cola. */
@Injectable()
export class SignedPdfCopyJobs implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly send: SendSignedPdfCopyJob,
    private readonly backfill: BackfillSignedConsentPdfs,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: SIGNED_PDF_COPY_JOB,
      maxAttempts: SIGNED_PDF_COPY_MAX_ATTEMPTS,
      handle: (payload) => this.send.handle(payload),
    });
    this.registry.register({
      name: SIGNED_PDF_BACKFILL_JOB,
      maxAttempts: 3,
      handle: async () => {
        await this.backfill.run();
      },
    });
    this.registry.schedule({
      name: SIGNED_PDF_BACKFILL_SCHEDULE,
      cron: SIGNED_PDF_BACKFILL_CRON,
      job: SIGNED_PDF_BACKFILL_JOB,
      // DX-380 (OPS-046): sin solapar un tick con el anterior.
      singleton: true,
    });
  }
}
