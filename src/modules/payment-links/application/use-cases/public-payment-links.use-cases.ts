import {
  BadRequestException,
  GoneException,
  HttpStatus,
  Inject,
  Injectable,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PaymentProofPolicy } from '@prisma/client';
import { civilDateIn, parseCivilDate } from '../../../../shared/time/civil-day';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { DocumentRegionalDto } from '../../../../shared/locations/document-regional.dto';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import { GetRatesForDateUseCase } from '../../../exchange/application/use-cases/get-rates-for-date.use-case';
import { BASE_CURRENCY } from '../../../exchange/domain/exchange-rate-source';
import { convertWithQuote } from '../../../exchange/domain/exchange-rate-quote';
import {
  offeredPaymentMethods,
  type PaymentInstructionFields,
} from '../../../payment-methods/domain/payment-method-instructions';
import {
  assertProofUploadRequest,
  PaymentProofUploads,
  type ProofUploadRequest,
  type ProofUploadTicket,
} from '../../../payments/application/payment-proof-uploads';
import {
  PAYMENT_LINK_CONCEPT_LABELS,
  PAYMENT_LINK_NOT_FOUND_MESSAGE,
  PAYMENT_LINK_USED_CODE,
  PAYMENT_LINK_USED_MESSAGE,
  PAYMENT_REPORT_PAID_ON_SLACK_DAYS,
  PROOF_UPLOADS_EXHAUSTED_CODE,
  PROOF_UPLOADS_EXHAUSTED_MESSAGE,
  REPORT_CURRENCY_MESSAGE,
  REPORT_CURRENCY_NOT_ACCEPTED_CODE,
  REPORT_OPENING_BALANCE_CURRENCY_MESSAGE,
  REPORT_METHOD_MESSAGE,
  REPORT_NOTE_MAX,
  REPORT_NOTE_TOO_LONG_MESSAGE,
  REPORT_PROOF_NOT_ALLOWED_MESSAGE,
  REPORT_PROOF_REQUIRED_MESSAGE,
  REPORT_PROOF_UNKNOWN_MESSAGE,
  REPORT_REFERENCE_MAX,
  REPORT_REFERENCE_REQUIRED_MESSAGE,
  REPORT_REFERENCE_TOO_LONG_MESSAGE,
  firstNameOnly,
  hashPaymentLinkToken,
  isWellFormedPaymentLinkToken,
  paidOnError,
  paymentLinkStatus,
  type PaymentLinkConcept,
} from '../../domain/payment-link';
import { addCivilDays } from '../../../../shared/time/civil-day';
import {
  PAYMENT_LINK_REPOSITORY,
  type ClinicBrandingRow,
  type PaymentLinkRepository,
  type PublicPaymentLinkRow,
} from '../../domain/ports/payment-link-repository.port';
import {
  PAYMENT_LINKS_CLOCK,
  type PaymentLinksClock,
} from '../payment-links-clock';

/** Propietario de las subidas del enlace (en vez de un usuario, D6). */
export function paymentLinkUploadOwner(linkId: string): string {
  return `payment-link:${linkId}`;
}

/** 410 «ya usado» con `status: 'REPORTED'` para que la página lo diga. */
function linkUsed(): GoneException {
  return new GoneException({
    statusCode: HttpStatus.GONE,
    error: 'Gone',
    code: PAYMENT_LINK_USED_CODE,
    status: 'REPORTED',
    message: PAYMENT_LINK_USED_MESSAGE,
  });
}

function notFound(): NotFoundException {
  return new NotFoundException(PAYMENT_LINK_NOT_FOUND_MESSAGE);
}

/**
 * Búsqueda común de las rutas públicas. El tenant sale SOLO del host
 * (DX-207); la RLS hace invisible un token de otra clínica: el mismo 404 que
 * uno inventado, caducado, anulado o de un paciente archivado. Usado: 410.
 */
async function findLiveLink(
  tenantContext: Pick<TenantContextService, 'getTenantId'>,
  repo: Pick<PaymentLinkRepository, 'findByTokenHash'>,
  token: string,
  now: Date,
): Promise<PublicPaymentLinkRow> {
  if (!tenantContext.getTenantId() || !isWellFormedPaymentLinkToken(token)) {
    throw notFound();
  }
  const link = await repo.findByTokenHash(hashPaymentLinkToken(token));
  if (!link) throw notFound();
  const status = paymentLinkStatus(link, now);
  if (status === 'USED') throw linkUsed();
  if (status !== 'LIVE') throw notFound();
  return link;
}

export interface PublicPaymentMethodView {
  id: string;
  name: string;
  requiresReference: boolean;
  proofPolicy: PaymentProofPolicy;
  instructions: PaymentInstructionFields;
}

export interface PublicPaymentLinkView {
  status: 'LIVE';
  clinic: ClinicBrandingRow | null;
  patientFirstName: string | null;
  /**
   * DX-354: zona, locale y reloj de la sede del enlace para pintar importes,
   * fechas y la caducidad; null si a la sede le falta algo.
   */
  regional: DocumentRegionalDto | null;
  concept: PaymentLinkConcept;
  conceptLabel: string;
  amount: number;
  currency: string;
  /**
   * El importe en las otras monedas que cobra la clínica, con la tasa del
   * día YA guardada (nunca se pide al proveedor). Vacía si no hay tasa de
   * hoy: la página dice «Consulta el importe en otra moneda con la clínica».
   */
  equivalents: { currency: string; amount: number }[];
  /** Día civil de la tasa usada; null sin equivalencias. */
  rateDate: string | null;
  /** Hay otras monedas pero no tasa de hoy guardada. */
  equivalentsUnavailable: boolean;
  /** Las monedas en que se puede reportar el pago. */
  currencies: string[];
  methods: PublicPaymentMethodView[];
  expiresAt: Date;
  /** Ventana de la fecha del pago (días civiles de la sede). */
  paidOnMin: string;
  paidOnMax: string;
  /** Hay un comprobante subido y preparado para el reporte. */
  stagedProof: {
    uploadId: string;
    name: string;
    mime: string;
    size: number;
  } | null;
  proofUploadsLeft: number;
}

/** Lo que el enlace ofrece y acepta: medios, monedas y la ventana de fecha. */
async function linkOffer(
  repo: Pick<PaymentLinkRepository, 'linkMethods' | 'clinicCurrencies'>,
  link: PublicPaymentLinkRow,
  now: Date,
) {
  const [{ methods, instructions }, clinicCurrencies] = await Promise.all([
    repo.linkMethods(),
    repo.clinicCurrencies(),
  ]);
  const offered = offeredPaymentMethods(methods, instructions, link.locationId);
  // Revisión del PR #176: un saldo migrado se abona solo en su moneda
  // (RecordOpeningBalancePayment no admite otra), sin equivalencias.
  const currencies = link.openingBalanceId
    ? [link.currency]
    : [...new Set([link.currency, ...clinicCurrencies])].sort();
  const timeZone = link.locationTimeZone ?? 'UTC';
  const linkCreatedOn = civilDateIn(link.createdAt, timeZone);
  const today = civilDateIn(now, timeZone);
  return { offered, currencies, linkCreatedOn, today };
}

/** PÚBLICO (D4): abrir el enlace es SOLO LECTURA. Nada clínico. */
@Injectable()
export class GetPublicPaymentLinkUseCase {
  constructor(
    @Inject(PAYMENT_LINK_REPOSITORY)
    private readonly repo: PaymentLinkRepository,
    private readonly rates: GetRatesForDateUseCase,
    private readonly tenantContext: TenantContextService,
    @Inject(PAYMENT_LINKS_CLOCK) private readonly clock: PaymentLinksClock,
  ) {}

  async execute(token: string): Promise<PublicPaymentLinkView> {
    const now = this.clock();
    const link = await findLiveLink(this.tenantContext, this.repo, token, now);
    const { offered, currencies, linkCreatedOn, today } = await linkOffer(
      this.repo,
      link,
      now,
    );
    const others = currencies.filter((c) => c !== link.currency);
    const equivalents = await this.equivalents(link, others, today);
    const staged = link.stagedProof;
    return {
      status: 'LIVE',
      clinic: await this.repo.clinicBranding(),
      patientFirstName: firstNameOnly(link.patientFirstName),
      regional: link.regional,
      concept: link.concept,
      conceptLabel: PAYMENT_LINK_CONCEPT_LABELS[link.concept],
      amount: link.amount,
      currency: link.currency,
      equivalents: equivalents?.items ?? [],
      rateDate: equivalents?.rateDate ?? null,
      equivalentsUnavailable: others.length > 0 && equivalents === null,
      currencies,
      methods: offered.map(({ method, instructions }) => ({
        id: method.id,
        name: method.name,
        requiresReference: method.requiresReference,
        proofPolicy: method.proofPolicy,
        instructions: {
          holderName: instructions.holderName,
          holderId: instructions.holderId,
          bankName: instructions.bankName,
          accountNumber: instructions.accountNumber,
          phone: instructions.phone,
          email: instructions.email,
          note: instructions.note,
        },
      })),
      expiresAt: link.expiresAt,
      paidOnMin: addCivilDays(
        linkCreatedOn,
        -PAYMENT_REPORT_PAID_ON_SLACK_DAYS,
      ),
      paidOnMax: today,
      stagedProof: staged
        ? {
            uploadId: staged.uploadId,
            name: staged.name,
            mime: staged.mime,
            size: staged.size,
          }
        : null,
      proofUploadsLeft: Math.max(0, 3 - link.proofUploadsIssued),
    };
  }

  /**
   * Las equivalencias con la tasa de HOY en la sede ya guardada (la del cobro
   * de hoy, sin llamar al proveedor). `null` si falta la de alguna moneda: se
   * dan todas o ninguna.
   */
  private async equivalents(
    link: PublicPaymentLinkRow,
    others: string[],
    today: string,
  ): Promise<{
    items: { currency: string; amount: number }[];
    rateDate: string | null;
  } | null> {
    if (others.length === 0) return { items: [], rateDate: null };
    const read = await this.rates.stored(today, {
      currencies: [link.currency, ...others],
    });
    if (!read) return null;
    const perBase = (c: string): number | undefined =>
      c === BASE_CURRENCY ? 1 : read.rates[c];
    const fromPerBase = perBase(link.currency);
    if (fromPerBase === undefined || fromPerBase <= 0) return null;
    const items: { currency: string; amount: number }[] = [];
    for (const currency of others) {
      const toPerBase = perBase(currency);
      if (toPerBase === undefined || toPerBase <= 0) return null;
      items.push({
        currency,
        amount: convertWithQuote(link.amount, {
          from: link.currency,
          to: currency,
          fromPerBase,
          toPerBase,
        }),
      });
    }
    return { items, rateDate: read.rateDate };
  }
}

/**
 * PÚBLICO: la página avisa de que el paciente la abrió (`openedAt`, solo la
 * primera vez). Idempotente y sin auditoría, como la anamnesis: los
 * previsualizadores de WhatsApp abren el GET solos.
 */
@Injectable()
export class MarkPaymentLinkOpenedUseCase {
  constructor(
    @Inject(PAYMENT_LINK_REPOSITORY)
    private readonly repo: PaymentLinkRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(PAYMENT_LINKS_CLOCK) private readonly clock: PaymentLinksClock,
  ) {}

  async execute(token: string): Promise<void> {
    const now = this.clock();
    const link = await findLiveLink(this.tenantContext, this.repo, token, now);
    if (link.openedAt === null) await this.repo.markOpened(link.id, now);
  }
}

/**
 * PÚBLICO (D6): autoriza UNA subida del comprobante con la misma subida
 * directa del abono (10 MB, JPG, PNG, WebP o PDF), con el enlace como
 * propietario. Como mucho 3 por enlace: la petición se comprueba antes y la
 * autorización se gasta antes de firmar nada (nunca se devuelve).
 */
@Injectable()
export class AuthorizePaymentLinkProofUploadUseCase {
  constructor(
    @Inject(PAYMENT_LINK_REPOSITORY)
    private readonly repo: PaymentLinkRepository,
    private readonly uploads: PaymentProofUploads,
    private readonly tenantContext: TenantContextService,
    @Inject(PAYMENT_LINKS_CLOCK) private readonly clock: PaymentLinksClock,
  ) {}

  async execute(
    token: string,
    request: ProofUploadRequest,
  ): Promise<ProofUploadTicket> {
    const now = this.clock();
    const link = await findLiveLink(this.tenantContext, this.repo, token, now);
    // Una petición que no vale (tamaño, huella, tipo) no gasta el cupo: se
    // comprueba antes (las autorizaciones solo suben, guarda de la BD).
    assertProofUploadRequest(request);
    if (!(await this.repo.reserveProofUpload(link.id, now))) {
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        code: PROOF_UPLOADS_EXHAUSTED_CODE,
        message: PROOF_UPLOADS_EXHAUSTED_MESSAGE,
      });
    }
    return this.uploads.authorize(request, paymentLinkUploadOwner(link.id));
  }
}

/**
 * PÚBLICO (D6): el navegador ya subió el fichero. Se comprueba por contenido
 * y se copia a su clave definitiva (como el comprobante del abono) y queda
 * como el comprobante preparado del enlace hasta el reporte; uno anterior se
 * descarta.
 */
@Injectable()
export class CompletePaymentLinkProofUploadUseCase {
  constructor(
    @Inject(PAYMENT_LINK_REPOSITORY)
    private readonly repo: PaymentLinkRepository,
    private readonly uploads: PaymentProofUploads,
    private readonly tenantContext: TenantContextService,
    @Inject(PAYMENT_LINKS_CLOCK) private readonly clock: PaymentLinksClock,
  ) {}

  async execute(
    token: string,
    uploadId: string,
  ): Promise<{ uploadId: string; name: string; mime: string; size: number }> {
    const now = this.clock();
    const link = await findLiveLink(this.tenantContext, this.repo, token, now);
    const completed = await this.uploads.complete(
      uploadId,
      paymentLinkUploadOwner(link.id),
    );
    const staged = await this.repo.stageProof(
      link.id,
      completed.attachment,
      this.clock(),
    );
    // El pendiente ya no hace falta: la copia es la que vale.
    await this.uploads.discard(completed.pendingKey);
    if (!staged) {
      // El enlace dejó de estar vivo mientras se copiaba: la copia sobra.
      await this.uploads.discard(completed.attachment.key);
      throw notFound();
    }
    if (staged.replacedKey && staged.replacedKey !== completed.attachment.key) {
      await this.uploads.discard(staged.replacedKey);
    }
    const { attachment } = completed;
    return {
      uploadId: attachment.uploadId,
      name: attachment.name,
      mime: attachment.mime,
      size: attachment.size,
    };
  }
}

export interface SubmitPaymentReportInput {
  paymentMethodId: string;
  currency: string;
  amount: number;
  reference?: string | null;
  paidOn: string;
  proofUploadId?: string | null;
  note?: string | null;
}

/**
 * PÚBLICO (D5): el paciente reporta su pago. Un solo reporte por enlace: el
 * UPDATE condicional del enlace y el alta del reporte van en la misma
 * transacción, auditada con actor público y origen PUBLIC_LINK.
 */
@Injectable()
export class SubmitPaymentReportUseCase {
  constructor(
    @Inject(PAYMENT_LINK_REPOSITORY)
    private readonly repo: PaymentLinkRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(PAYMENT_LINKS_CLOCK) private readonly clock: PaymentLinksClock,
  ) {}

  async execute(
    token: string,
    input: SubmitPaymentReportInput,
    meta: AuditRequestMeta,
  ): Promise<{ status: 'REPORTED'; message: string }> {
    const now = this.clock();
    const link = await findLiveLink(this.tenantContext, this.repo, token, now);
    const { offered, currencies, linkCreatedOn, today } = await linkOffer(
      this.repo,
      link,
      now,
    );
    const method = offered.find(
      (o) => o.method.id === input.paymentMethodId,
    )?.method;
    if (!method) throw new BadRequestException(REPORT_METHOD_MESSAGE);
    const currency = input.currency.trim().toUpperCase();
    if (link.openingBalanceId && currency !== link.currency) {
      throw new UnprocessableEntityException({
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        error: 'Unprocessable Entity',
        code: REPORT_CURRENCY_NOT_ACCEPTED_CODE,
        message: REPORT_OPENING_BALANCE_CURRENCY_MESSAGE,
      });
    }
    if (!currencies.includes(currency)) {
      throw new BadRequestException(REPORT_CURRENCY_MESSAGE);
    }
    const reference = input.reference?.trim() || null;
    if (reference === null && method.requiresReference) {
      throw new BadRequestException(REPORT_REFERENCE_REQUIRED_MESSAGE);
    }
    if (reference !== null && reference.length > REPORT_REFERENCE_MAX) {
      throw new BadRequestException(REPORT_REFERENCE_TOO_LONG_MESSAGE);
    }
    const paidOn = parseCivilDate(input.paidOn.trim());
    if (paidOn === null) {
      throw new BadRequestException(
        'La fecha del pago tiene que ser un día válido (AAAA-MM-DD).',
      );
    }
    const dateError = paidOnError(paidOn, { linkCreatedOn, today });
    if (dateError) throw new BadRequestException(dateError);
    const note = input.note?.trim() || null;
    if (note !== null && note.length > REPORT_NOTE_MAX) {
      throw new BadRequestException(REPORT_NOTE_TOO_LONG_MESSAGE);
    }
    const proofUploadId = input.proofUploadId?.trim() || null;
    const proof =
      proofUploadId === null
        ? null
        : link.stagedProof?.uploadId === proofUploadId
          ? link.stagedProof
          : undefined;
    if (proof === undefined) {
      throw new BadRequestException(REPORT_PROOF_UNKNOWN_MESSAGE);
    }
    if (method.proofPolicy === 'REQUIRED' && proof === null) {
      throw new BadRequestException(REPORT_PROOF_REQUIRED_MESSAGE);
    }
    if (method.proofPolicy === 'NONE' && proof !== null) {
      throw new BadRequestException(REPORT_PROOF_NOT_ALLOWED_MESSAGE);
    }

    const outcome = await this.repo.submitReport({
      id: randomUUID(),
      linkId: link.id,
      paymentMethodId: method.id,
      amount: input.amount,
      currency,
      reference,
      paidOn,
      note,
      proof,
      now: this.clock(),
      meta,
    });
    if (outcome.kind === 'USED') throw linkUsed();
    if (outcome.kind === 'GONE') throw notFound();
    if (outcome.kind === 'PROOF_CHANGED') {
      throw new BadRequestException(REPORT_PROOF_UNKNOWN_MESSAGE);
    }
    return { status: 'REPORTED', message: PAYMENT_LINK_USED_MESSAGE };
  }
}
