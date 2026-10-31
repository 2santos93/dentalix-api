import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { ConsentSignerType, SignatureRequestType } from '@prisma/client';
import { firstNameOnly } from '../../../appointment-confirmations/application/confirmation-token';
import { computeRemoteConsentHash } from '../../../consents/domain/consent-hash';
import {
  parseSignaturePng,
  SignatureImageError,
} from '../../../consents/domain/signature-image';
import { describeDeliveryError } from '../../../notifications/email/application/retry-policy';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  PublicSignatureContext,
  SignatureRequestRecord,
} from '../../domain/entities/signature-request.entity';
import {
  SIGNATURE_REQUEST_REPOSITORY,
  type LockedWrite,
  type PublicRequestEvidence,
  type SignatureRequestRepository,
} from '../../domain/ports/signature-request-repository.port';
import {
  SIGNATURE_CODE_MAX_ATTEMPTS,
  SIGNATURE_CODE_MAX_SENDS,
  SIGNATURE_CODE_TTL_MINUTES,
  codeResendWaitSeconds,
  generateSignatureCode,
  hmacSignatureCode,
  signatureCodeExpiry,
  signatureCodeMatches,
} from '../../domain/signature-code';
import { isLinkUsable } from '../../domain/signature-request-status';
import {
  generateSignatureToken,
  hashSignatureToken,
  isWellFormedSignatureToken,
  signatureSessionExpiry,
} from '../../domain/signature-token';
import {
  SIGNATURE_CLOCK,
  SIGNATURE_CODE_KEY,
  type SignatureClock,
} from '../signature-clock';
import {
  SIGNATURE_EMAIL_SENDER,
  type SignatureEmailSender,
} from '../signature-email';

/**
 * Lo único que dice un enlace que no sirve: desconocido, de otra clínica,
 * caducado, usado, anulado o bloqueado responden igual, sin revelar cuál ni
 * ningún dato del documento o del paciente.
 */
export const SIGNATURE_LINK_INVALID_MESSAGE = 'Enlace no válido';
export const SIGNATURE_SESSION_REQUIRED_CODE = 'SIGNATURE_SESSION_REQUIRED';
export const SIGNATURE_SESSION_REQUIRED_MESSAGE =
  'Tu verificación caducó: pide un código nuevo para continuar.';
export const SIGNATURE_CODE_EXPIRED_CODE = 'SIGNATURE_CODE_EXPIRED';
export const SIGNATURE_CODE_EXPIRED_MESSAGE =
  'El código caducó o ya se usó: pide uno nuevo.';
export const SIGNATURE_CODE_INVALID_CODE = 'SIGNATURE_CODE_INVALID';
export const SIGNATURE_LINK_LOCKED_CODE = 'SIGNATURE_LINK_LOCKED';
export const SIGNATURE_LINK_LOCKED_MESSAGE =
  'Código incorrecto. Agotaste los 5 intentos y el enlace se bloqueó: pide a la clínica uno nuevo.';
export const SIGNATURE_CODE_MAX_SENDS_MESSAGE =
  'Ya te enviamos el código 5 veces: pide a la clínica un enlace nuevo.';
export const SIGNATURE_CODE_NOT_SENT_MESSAGE =
  'No pudimos enviarte el código. Vuelve a pedirlo en un minuto.';
export const SIGNATURE_NOT_READ_MESSAGE =
  'Confirma que leíste el documento completo antes de firmar.';
export const SIGNATURE_DOCUMENT_REQUIRED_MESSAGE =
  'Escribe tu documento de identidad: firmas como responsable del paciente.';

const SIGNER_DOCUMENT_MAX = 60;

function invalidLink(): NotFoundException {
  return new NotFoundException(SIGNATURE_LINK_INVALID_MESSAGE);
}

function sessionRequired(): ForbiddenException {
  return new ForbiddenException({
    statusCode: HttpStatus.FORBIDDEN,
    error: 'Forbidden',
    code: SIGNATURE_SESSION_REQUIRED_CODE,
    message: SIGNATURE_SESSION_REQUIRED_MESSAGE,
  });
}

function tooManyRequests(message: string, retryAfterSeconds: number) {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      message,
      retryAfterSeconds,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/** ¿Es la sesión que se dio al verificar el código, y sigue viva? */
export function sessionMatches(
  request: Pick<SignatureRequestRecord, 'sessionHash' | 'sessionExpiresAt'>,
  session: string | undefined,
  now: Date,
): boolean {
  if (
    !session ||
    !isWellFormedSignatureToken(session) ||
    !request.sessionHash ||
    !request.sessionExpiresAt ||
    request.sessionExpiresAt.getTime() <= now.getTime()
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(hashSignatureToken(session), 'hex'),
    Buffer.from(request.sessionHash, 'hex'),
  );
}

/**
 * Búsqueda común de las rutas públicas. El tenant sale SOLO del host: sin
 * clínica en contexto, o con un token que no puede ser nuestro, es 404 sin
 * tocar la base. La RLS hace que un token de otra clínica no exista.
 */
async function findLive(
  tenantContext: TenantContextService,
  repo: SignatureRequestRepository,
  token: string,
  now: Date,
): Promise<PublicSignatureContext> {
  if (!tenantContext.getTenantId() || !isWellFormedSignatureToken(token)) {
    throw invalidLink();
  }
  const ctx = await repo.findByTokenHash(hashSignatureToken(token));
  if (!ctx || !isLinkUsable(ctx.request, now)) throw invalidLink();
  return ctx;
}

export interface PublicSignatureView {
  type: SignatureRequestType;
  clinic: PublicSignatureContext['clinic'];
  location: PublicSignatureContext['location'];
  destinationMasked: string;
  expiresAt: Date;
  /** Hay un código vigente enviado. */
  codeSent: boolean;
  /** Desde cuándo se puede pedir otro (null = ya). */
  resendAvailableAt: Date | null;
  /** Envíos del código que quedan. */
  codeSendsLeft: number;
}

function viewOf(ctx: PublicSignatureContext, now: Date): PublicSignatureView {
  const { request } = ctx;
  const wait = codeResendWaitSeconds(request.codeSentAt, now);
  return {
    type: request.type,
    clinic: ctx.clinic,
    location: ctx.location,
    destinationMasked: request.destinationMasked,
    expiresAt: request.expiresAt,
    codeSent:
      request.codeHash !== null &&
      request.codeExpiresAt !== null &&
      request.codeExpiresAt.getTime() > now.getTime(),
    resendAvailableAt: wait > 0 ? new Date(now.getTime() + wait * 1000) : null,
    codeSendsLeft: Math.max(
      0,
      SIGNATURE_CODE_MAX_SENDS - request.codeSendCount,
    ),
  };
}

/**
 * PÚBLICO: estado mínimo del enlace (marca de la clínica, destino
 * enmascarado y caducidad). SOLO LECTURA: los previsualizadores de enlaces lo
 * abren solos; la apertura cuenta al pedir el código.
 */
@Injectable()
export class GetPublicSignatureUseCase {
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(SIGNATURE_REQUEST_REPOSITORY)
    private readonly repo: SignatureRequestRepository,
    @Inject(SIGNATURE_CLOCK) private readonly clock: SignatureClock,
  ) {}

  async execute(token: string): Promise<PublicSignatureView> {
    const now = this.clock();
    return viewOf(
      await findLive(this.tenantContext, this.repo, token, now),
      now,
    );
  }
}

type CodeOutcome =
  | { kind: 'INVALID' }
  | { kind: 'MAX' }
  | { kind: 'WAIT'; seconds: number }
  | { kind: 'SEND'; code: string };

/**
 * PÚBLICO: pide (o reenvía) el código de 6 dígitos al destino del enlace. La
 * primera vez marca la apertura. Como mucho 5 envíos, con 60 s entre uno y
 * otro; pedir un código nuevo NO devuelve intentos (son 5 por enlace).
 */
@Injectable()
export class RequestSignatureCodeUseCase {
  private readonly logger = new Logger('SignatureRequests');

  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(SIGNATURE_REQUEST_REPOSITORY)
    private readonly repo: SignatureRequestRepository,
    @Inject(SIGNATURE_EMAIL_SENDER)
    private readonly email: SignatureEmailSender,
    @Inject(SIGNATURE_CODE_KEY) private readonly codeKey: Buffer,
    @Inject(SIGNATURE_CLOCK) private readonly clock: SignatureClock,
  ) {}

  async execute(
    token: string,
    evidence: PublicRequestEvidence,
  ): Promise<PublicSignatureView> {
    const now = this.clock();
    const ctx = await findLive(this.tenantContext, this.repo, token, now);
    const outcome = await this.repo.withLockedRequest<CodeOutcome>(
      ctx.request.id,
      evidence,
      (request) => {
        if (!isLinkUsable(request, now)) {
          return { write: null, result: { kind: 'INVALID' } };
        }
        if (request.codeSendCount >= SIGNATURE_CODE_MAX_SENDS) {
          return { write: null, result: { kind: 'MAX' } };
        }
        const seconds = codeResendWaitSeconds(request.codeSentAt, now);
        if (seconds > 0) {
          return { write: null, result: { kind: 'WAIT', seconds } };
        }
        const code = generateSignatureCode();
        const write: LockedWrite = {
          patch: {
            codeHash: hmacSignatureCode(this.codeKey, request.id, code),
            codeExpiresAt: signatureCodeExpiry(now),
            codeSentAt: now,
            codeSendCount: request.codeSendCount + 1,
            openedAt: request.openedAt ?? now,
          },
          audit: [
            ...(request.openedAt
              ? []
              : [
                  {
                    action: 'VIEW',
                    reason: 'SIGNATURE_LINK_OPENED',
                  } as const,
                ]),
            { action: 'SEND', reason: 'SIGNATURE_CODE_SENT' },
          ],
        };
        return { write, result: { kind: 'SEND', code } };
      },
    );
    if (!outcome || outcome.kind === 'INVALID') throw invalidLink();
    if (outcome.kind === 'MAX') {
      throw tooManyRequests(SIGNATURE_CODE_MAX_SENDS_MESSAGE, 60 * 60);
    }
    if (outcome.kind === 'WAIT') {
      throw tooManyRequests(
        `Espera ${outcome.seconds} ${outcome.seconds === 1 ? 'segundo' : 'segundos'} antes de pedir otro código.`,
        outcome.seconds,
      );
    }
    try {
      await this.email.sendCode({
        to: ctx.request.destination,
        referenceId: ctx.request.id,
        vars: {
          recipientFirstName:
            firstNameOnly(ctx.request.signerName) ?? ctx.request.signerName,
          clinicName: ctx.clinic.name,
          code: outcome.code,
          expiresInMinutes: SIGNATURE_CODE_TTL_MINUTES,
        },
      });
    } catch (err) {
      // El código quedó guardado pero no salió: se puede pedir otro en un
      // minuto. Nunca se registra el código ni el destinatario.
      this.logger.warn({
        event: 'signature_request.code_not_enqueued',
        signatureRequestId: ctx.request.id,
        error: describeDeliveryError(err),
      });
      throw new ServiceUnavailableException(SIGNATURE_CODE_NOT_SENT_MESSAGE);
    }
    const fresh = await this.repo.findByTokenHash(ctx.request.tokenHash);
    if (!fresh) throw invalidLink();
    return viewOf(fresh, now);
  }
}

type VerifyOutcome =
  | { kind: 'INVALID' }
  | { kind: 'CODE_EXPIRED' }
  | { kind: 'WRONG'; attemptsLeft: number }
  | { kind: 'LOCKED' }
  | { kind: 'OK'; session: string; sessionExpiresAt: Date };

export interface VerifiedSignatureSession {
  /** Secreto de la sesión de este navegador: va en `X-Signature-Session`. */
  sessionToken: string;
  sessionExpiresAt: Date;
}

/**
 * PÚBLICO: verifica el código. Con la fila bloqueada: nunca se evalúan más
 * de 5 códigos por enlace aunque lleguen a la vez. Al acertar, el código deja
 * de servir y el navegador recibe una sesión de 30 min (solo se guarda su
 * hash); al quinto fallo el enlace queda bloqueado y la ficha lo muestra.
 */
@Injectable()
export class VerifySignatureCodeUseCase {
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(SIGNATURE_REQUEST_REPOSITORY)
    private readonly repo: SignatureRequestRepository,
    @Inject(SIGNATURE_CODE_KEY) private readonly codeKey: Buffer,
    @Inject(SIGNATURE_CLOCK) private readonly clock: SignatureClock,
  ) {}

  async execute(
    token: string,
    code: string,
    evidence: PublicRequestEvidence,
  ): Promise<VerifiedSignatureSession> {
    const now = this.clock();
    const ctx = await findLive(this.tenantContext, this.repo, token, now);
    const outcome = await this.repo.withLockedRequest<VerifyOutcome>(
      ctx.request.id,
      evidence,
      (request) => {
        if (!isLinkUsable(request, now)) {
          return { write: null, result: { kind: 'INVALID' } };
        }
        if (
          !request.codeHash ||
          !request.codeExpiresAt ||
          request.codeExpiresAt.getTime() <= now.getTime()
        ) {
          return { write: null, result: { kind: 'CODE_EXPIRED' } };
        }
        if (
          signatureCodeMatches(this.codeKey, request.id, code, request.codeHash)
        ) {
          const session = generateSignatureToken();
          const sessionExpiresAt = signatureSessionExpiry(
            now,
            request.expiresAt,
          );
          return {
            write: {
              patch: {
                codeHash: null,
                codeExpiresAt: null,
                verifiedAt: request.verifiedAt ?? now,
                sessionHash: hashSignatureToken(session),
                sessionExpiresAt,
              },
              audit: [{ action: 'UPDATE', reason: 'SIGNATURE_CODE_VERIFIED' }],
            },
            result: { kind: 'OK', session, sessionExpiresAt },
          };
        }
        const failedAttempts = request.failedAttempts + 1;
        if (failedAttempts >= SIGNATURE_CODE_MAX_ATTEMPTS) {
          return {
            write: {
              patch: {
                failedAttempts,
                lockedAt: now,
                codeHash: null,
                codeExpiresAt: null,
                sessionHash: null,
                sessionExpiresAt: null,
              },
              audit: [{ action: 'UPDATE', reason: 'SIGNATURE_LINK_LOCKED' }],
            },
            result: { kind: 'LOCKED' },
          };
        }
        return {
          write: { patch: { failedAttempts }, audit: [] },
          result: {
            kind: 'WRONG',
            attemptsLeft: SIGNATURE_CODE_MAX_ATTEMPTS - failedAttempts,
          },
        };
      },
    );
    if (!outcome || outcome.kind === 'INVALID') throw invalidLink();
    switch (outcome.kind) {
      case 'CODE_EXPIRED':
        throw new BadRequestException({
          statusCode: HttpStatus.BAD_REQUEST,
          error: 'Bad Request',
          code: SIGNATURE_CODE_EXPIRED_CODE,
          message: SIGNATURE_CODE_EXPIRED_MESSAGE,
        });
      case 'WRONG':
        throw new BadRequestException({
          statusCode: HttpStatus.BAD_REQUEST,
          error: 'Bad Request',
          code: SIGNATURE_CODE_INVALID_CODE,
          message: `Código incorrecto. Te ${outcome.attemptsLeft === 1 ? 'queda 1 intento' : `quedan ${outcome.attemptsLeft} intentos`}.`,
          attemptsLeft: outcome.attemptsLeft,
        });
      case 'LOCKED':
        throw new BadRequestException({
          statusCode: HttpStatus.BAD_REQUEST,
          error: 'Bad Request',
          code: SIGNATURE_LINK_LOCKED_CODE,
          message: SIGNATURE_LINK_LOCKED_MESSAGE,
          attemptsLeft: 0,
        });
      case 'OK':
        return {
          sessionToken: outcome.session,
          sessionExpiresAt: outcome.sessionExpiresAt,
        };
    }
  }
}

export interface PublicSignatureDocument {
  type: SignatureRequestType;
  title: string;
  /** El texto exacto que se firma (variables ya resueltas). */
  body: string;
  templateVersion: number | null;
  signerType: ConsentSignerType;
  signerName: string;
  /** Firma un responsable sin documento registrado: lo escribe al firmar. */
  signerDocumentRequired: boolean;
  professionalName: string;
  sentAt: Date;
  expiresAt: Date;
  clinic: PublicSignatureContext['clinic'];
  location: PublicSignatureContext['location'];
}

function documentOf(ctx: PublicSignatureContext): PublicSignatureDocument {
  const { request } = ctx;
  return {
    type: request.type,
    title: request.title,
    body: request.body,
    templateVersion: request.templateVersion,
    signerType: request.signerType,
    signerName: request.signerName,
    signerDocumentRequired:
      request.signerType === 'GUARDIAN' && !request.signerDocument,
    professionalName: request.professionalName,
    sentAt: request.createdAt,
    expiresAt: request.expiresAt,
    clinic: ctx.clinic,
    location: ctx.location,
  };
}

/** PÚBLICO: el documento completo, solo con la sesión del código verificado. */
@Injectable()
export class GetPublicSignatureDocumentUseCase {
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(SIGNATURE_REQUEST_REPOSITORY)
    private readonly repo: SignatureRequestRepository,
    @Inject(SIGNATURE_CLOCK) private readonly clock: SignatureClock,
  ) {}

  async execute(
    token: string,
    session: string | undefined,
  ): Promise<PublicSignatureDocument> {
    const now = this.clock();
    const ctx = await findLive(this.tenantContext, this.repo, token, now);
    if (!sessionMatches(ctx.request, session, now)) throw sessionRequired();
    return documentOf(ctx);
  }
}

export interface SignPublicSignatureInput {
  signature: string;
  signerDocument?: string;
  /** El firmante confirma que leyó el documento completo. */
  accepted: boolean;
}

export interface PublicSignedCopy extends PublicSignatureDocument {
  signerDocument: string | null;
  signedAt: Date;
  /** SHA-256 del texto, la versión, el firmante, la firma y las evidencias. */
  contentHash: string;
}

type SignOutcome =
  | { kind: 'INVALID' }
  | { kind: 'SESSION' }
  | {
      kind: 'SIGNED';
      signedAt: Date;
      contentHash: string;
      signerDocument: string | null;
    };

/**
 * PÚBLICO: el paciente (o su responsable) firma. La firma se guarda en
 * patient_consents con su hash y sus evidencias (canal, destino enmascarado,
 * envío, apertura, verificación, IP, navegador y `signedAt` del servidor):
 * inmutable. El enlace queda usado. Solo cuenta como «Completo» cuando
 * además firma el profesional en la app.
 */
@Injectable()
export class SignPublicSignatureUseCase {
  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(SIGNATURE_REQUEST_REPOSITORY)
    private readonly repo: SignatureRequestRepository,
    @Inject(SIGNATURE_CLOCK) private readonly clock: SignatureClock,
  ) {}

  async execute(
    token: string,
    session: string | undefined,
    input: SignPublicSignatureInput,
    evidence: PublicRequestEvidence,
  ): Promise<PublicSignedCopy> {
    const now = this.clock();
    const ctx = await findLive(this.tenantContext, this.repo, token, now);
    if (!sessionMatches(ctx.request, session, now)) throw sessionRequired();
    if (!input.accepted)
      throw new BadRequestException(SIGNATURE_NOT_READ_MESSAGE);
    const typedDocument = input.signerDocument?.trim() ?? '';
    const documentRequired =
      ctx.request.signerType === 'GUARDIAN' && !ctx.request.signerDocument;
    if (
      documentRequired &&
      (typedDocument === '' || typedDocument.length > SIGNER_DOCUMENT_MAX)
    ) {
      throw new BadRequestException(SIGNATURE_DOCUMENT_REQUIRED_MESSAGE);
    }
    // La firma se descomprime para buscar tinta (SEC-026): solo con el enlace
    // y la sesión ya comprobados.
    let signature: string;
    try {
      signature = parseSignaturePng(
        input.signature,
        ctx.request.signerType === 'GUARDIAN'
          ? 'la firma del responsable'
          : 'la firma del paciente',
      );
    } catch (error) {
      if (error instanceof SignatureImageError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    const outcome = await this.repo.withLockedRequest<SignOutcome>(
      ctx.request.id,
      evidence,
      (request) => {
        if (!isLinkUsable(request, now)) {
          return { write: null, result: { kind: 'INVALID' } };
        }
        if (
          !sessionMatches(request, session, now) ||
          !request.openedAt ||
          !request.verifiedAt ||
          !request.templateId ||
          !request.templateVersion
        ) {
          return { write: null, result: { kind: 'SESSION' } };
        }
        const signerDocument =
          request.signerDocument ?? (typedDocument || null);
        const userAgent = evidence.userAgent?.slice(0, 512) ?? null;
        const contentHash = computeRemoteConsentHash({
          title: request.title,
          body: request.body,
          templateVersion: request.templateVersion,
          signerType: request.signerType,
          signerName: request.signerName,
          signerDocument,
          professionalName: request.professionalName,
          patientSignature: signature,
          signedAt: now,
          channel: request.channel,
          destinationMasked: request.destinationMasked,
          sentAt: request.createdAt,
          openedAt: request.openedAt,
          verifiedAt: request.verifiedAt,
          ipAddress: evidence.ipAddress,
          userAgent,
        });
        return {
          write: {
            patch: {
              signedAt: now,
              sessionHash: null,
              sessionExpiresAt: null,
              codeHash: null,
              codeExpiresAt: null,
            },
            audit: [{ action: 'SIGN', reason: 'SIGNATURE_PATIENT_SIGNED' }],
            consent: {
              templateId: request.templateId,
              templateVersion: request.templateVersion,
              treatmentPlanId: request.treatmentPlanId,
              title: request.title,
              body: request.body,
              signerType: request.signerType,
              signerName: request.signerName,
              signerDocument,
              professionalName: request.professionalName,
              patientSignature: signature,
              contentHash,
              signedAt: now,
              recordedById: request.createdById,
              ipAddress: evidence.ipAddress,
              userAgent,
              remoteChannel: request.channel,
              remoteDestinationMasked: request.destinationMasked,
              remoteSentAt: request.createdAt,
              remoteOpenedAt: request.openedAt,
              remoteVerifiedAt: request.verifiedAt,
            },
          },
          result: {
            kind: 'SIGNED',
            signedAt: now,
            contentHash,
            signerDocument,
          },
        };
      },
    );
    if (!outcome || outcome.kind === 'INVALID') throw invalidLink();
    if (outcome.kind === 'SESSION') throw sessionRequired();
    return {
      ...documentOf(ctx),
      signerDocumentRequired: false,
      signerDocument: outcome.signerDocument,
      signedAt: outcome.signedAt,
      contentHash: outcome.contentHash,
    };
  }
}
