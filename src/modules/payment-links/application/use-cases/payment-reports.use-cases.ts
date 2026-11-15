import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PaymentReportStatus } from '@prisma/client';
import {
  FILE_STORAGE,
  type FileStoragePort,
} from '../../../../shared/storage/file-storage.port';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { currentRequestId } from '../../../../shared/observability/request-context';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import {
  PAYMENT_METHOD_REPOSITORY,
  type PaymentMethodRepository,
} from '../../../payment-methods/domain/ports/payment-method-repository.port';
import { PAYMENT_PROOF_URL_TTL } from '../../../payments/application/payment-proof-tokens';
import { RecordOpeningBalancePaymentUseCase } from '../../../payments/application/use-cases/record-opening-balance-payment.use-case';
import {
  RecordPaymentUseCase,
  type RecordPaymentInput,
} from '../../../payments/application/use-cases/record-payment.use-case';
import type { Payment } from '../../../payments/domain/entities/payment.entity';
import {
  PAYMENT_REPOSITORY,
  type PaymentInsertHook,
  type PaymentRepository,
} from '../../../payments/domain/ports/payment-repository.port';
import { PAYMENT_METHOD_NOT_FOUND_MESSAGE } from '../../../payment-methods/domain/payment-method-rules';
import {
  PAYMENT_REPORT_CONFIRMED_REASON,
  PAYMENT_REPORT_NOT_FOUND_MESSAGE,
  PAYMENT_REPORT_NOT_PENDING_CODE,
  PAYMENT_REPORT_NOT_PENDING_MESSAGE,
  PAYMENT_REPORT_NO_PROOF_MESSAGE,
  PAYMENT_REPORT_PROOF_VIEWED_REASON,
  OPENING_BALANCE_CURRENCY_FIXED_CODE,
  OPENING_BALANCE_CURRENCY_FIXED_MESSAGE,
  RATE_OVERRIDE_NOT_FOR_OPENING_BALANCE_CODE,
  RATE_OVERRIDE_NOT_FOR_OPENING_BALANCE_MESSAGE,
  RATE_OVERRIDE_REASON_MESSAGE,
  REJECT_REASON_MAX,
  REJECT_REASON_MESSAGE,
  firstNameOnly,
} from '../../domain/payment-link';
import {
  PAYMENT_LINK_REPOSITORY,
  type PaymentLinkRepository,
  type PaymentReportRow,
} from '../../domain/ports/payment-link-repository.port';
import {
  PAYMENT_LINK_EMAILS,
  type PaymentLinkEmails,
} from '../payment-link-emails';
import {
  PAYMENT_LINKS_CLOCK,
  type PaymentLinksClock,
} from '../payment-links-clock';

export const RATE_OVERRIDE_REASON_MAX = 280;

/**
 * Las sedes de la bandeja, como Caja: la sede pedida (403 si no está
 * permitida); sin ella, la de la cabecera o las permitidas; `undefined` sin
 * restricción.
 */
function reportScope(
  tenantContext: TenantContextService,
  locationId: string | undefined,
): string[] | undefined {
  if (locationId) {
    tenantContext.assertLocationAllowed(locationId);
    return [locationId];
  }
  return tenantContext.scopeLocationIds();
}

/** Una tasa como decimal en texto, sin ceros de más («250.5»). */
function rateText(rate: number): string {
  return rate.toFixed(8).replace(/\.?0+$/, '');
}

function unprocessable(code: string, message: string) {
  return new UnprocessableEntityException({
    statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    error: 'Unprocessable Entity',
    code,
    message,
  });
}

function notPending(): ConflictException {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code: PAYMENT_REPORT_NOT_PENDING_CODE,
    message: PAYMENT_REPORT_NOT_PENDING_MESSAGE,
  });
}

/** `GET /payment-reports`: la bandeja «Pagos por confirmar» (D9). */
@Injectable()
export class ListPaymentReportsUseCase {
  constructor(
    @Inject(PAYMENT_LINK_REPOSITORY)
    private readonly repo: PaymentLinkRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  execute(query: {
    status?: PaymentReportStatus;
    page: number;
    pageSize: number;
    locationId?: string;
  }): Promise<{ items: PaymentReportRow[]; total: number }> {
    return this.repo.listReports({
      status: query.status ?? null,
      locationIds: reportScope(this.tenantContext, query.locationId),
      page: query.page,
      pageSize: query.pageSize,
    });
  }
}

/** `GET /payment-reports/count`: los pendientes (la cola de «Mi día»). */
@Injectable()
export class CountPaymentReportsUseCase {
  constructor(
    @Inject(PAYMENT_LINK_REPOSITORY)
    private readonly repo: PaymentLinkRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(
    query: { locationId?: string } = {},
  ): Promise<{ pending: number }> {
    return {
      pending: await this.repo.countReports(
        'PENDING',
        reportScope(this.tenantContext, query.locationId),
      ),
    };
  }
}

/** Un reporte de la clínica en una sede permitida al usuario (404 / 403). */
async function loadReport(
  repo: Pick<PaymentLinkRepository, 'findReport'>,
  tenantContext: TenantContextService,
  id: string,
): Promise<PaymentReportRow> {
  const report = await repo.findReport(id);
  if (!report) throw new NotFoundException(PAYMENT_REPORT_NOT_FOUND_MESSAGE);
  tenantContext.assertRecordLocationAllowed(report.locationId);
  return report;
}

export interface PaymentReportProofUrl {
  url: string;
  expiresAt: string;
  mime: string;
  name: string;
}

/**
 * `GET /payment-reports/:id/proof-url` (D6): URL firmada de 5 minutos para
 * ver el comprobante del reporte, auditada (VIEW de PAYMENT_REPORT).
 */
@Injectable()
export class GetPaymentReportProofUrlUseCase {
  constructor(
    @Inject(PAYMENT_LINK_REPOSITORY)
    private readonly repo: PaymentLinkRepository,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
    private readonly audit: RecordAuditEventUseCase,
    private readonly tenantContext: TenantContextService,
    @Inject(PAYMENT_PROOF_URL_TTL) private readonly ttlSeconds: number,
    @Inject(PAYMENT_LINKS_CLOCK) private readonly clock: PaymentLinksClock,
  ) {}

  async execute(
    id: string,
    ctx: AuditRequestContext | undefined,
  ): Promise<PaymentReportProofUrl> {
    const issuedAt = this.clock();
    const report = await loadReport(this.repo, this.tenantContext, id);
    if (!report.proof) {
      throw new NotFoundException(PAYMENT_REPORT_NO_PROOF_MESSAGE);
    }
    const { proof } = report;
    const url = await this.storage.getSignedUrl(proof.key, this.ttlSeconds, {
      disposition: 'inline',
      filename: proof.name,
      contentType: proof.mime,
    });
    if (ctx) {
      await this.audit.record({
        tenantId: ctx.tenantId,
        locationId: report.locationId,
        actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
        action: 'VIEW',
        resourceType: 'PAYMENT_REPORT',
        resourceId: report.id,
        patient: { kind: 'patient', id: report.patientId },
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: { reason: PAYMENT_REPORT_PROOF_VIEWED_REASON },
      });
    }
    return {
      url,
      expiresAt: new Date(
        issuedAt.getTime() + this.ttlSeconds * 1000,
      ).toISOString(),
      mime: proof.mime,
      name: proof.name,
    };
  }
}

/** Correcciones de recepción antes de confirmar (lo que llegó de verdad). */
export interface ConfirmPaymentReportInput {
  amount?: number;
  currency?: string;
  paymentMethodId?: string;
  /** `null` o vacío quita la referencia del reporte. */
  reference?: string | null;
  paidOn?: string;
  rateOverride?: number;
  rateOverrideReason?: string;
  duplicateReferenceReason?: string;
}

export interface ConfirmedPaymentReport {
  reportId: string;
  status: 'CONFIRMED';
  payment: Payment;
}

const CORRECTABLE = [
  'amount',
  'currency',
  'paymentMethodId',
  'reference',
  'paidOn',
] as const;

/**
 * `POST /payment-reports/:id/confirm` (D7): registra el abono con los MISMOS
 * casos de uso que Caja (`Idempotency-Key` = id del reporte, la caja de quien
 * confirma, el comprobante del reporte como `PaymentProof`, la tasa del día
 * del pago) y deja el reporte CONFIRMED con su abono DENTRO de la
 * transacción del abono (`afterInsertInTx`). Dos confirmaciones (a la vez o
 * repetidas) dan un solo abono: la segunda devuelve el mismo.
 */
@Injectable()
export class ConfirmPaymentReportUseCase {
  private readonly logger = new Logger('PaymentReports');

  constructor(
    @Inject(PAYMENT_LINK_REPOSITORY)
    private readonly repo: PaymentLinkRepository,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: PaymentRepository,
    @Inject(PAYMENT_METHOD_REPOSITORY)
    private readonly methods: PaymentMethodRepository,
    private readonly recordPayment: RecordPaymentUseCase,
    private readonly recordBalancePayment: RecordOpeningBalancePaymentUseCase,
    private readonly tenantContext: TenantContextService,
    @Inject(PAYMENT_LINKS_CLOCK) private readonly clock: PaymentLinksClock,
  ) {}

  async execute(
    id: string,
    input: ConfirmPaymentReportInput,
    audit: AuditRequestContext,
  ): Promise<ConfirmedPaymentReport> {
    const report = await loadReport(this.repo, this.tenantContext, id);
    if (report.status === 'CONFIRMED') return this.alreadyConfirmed(report);
    if (report.status !== 'PENDING') throw notPending();

    // Un saldo migrado se abona en su moneda: ni otra moneda ni otra tasa
    // (RecordOpeningBalancePayment solo admite la suya). 422 con código.
    if (report.link.openingBalanceId) {
      if (input.rateOverride !== undefined) {
        throw unprocessable(
          RATE_OVERRIDE_NOT_FOR_OPENING_BALANCE_CODE,
          RATE_OVERRIDE_NOT_FOR_OPENING_BALANCE_MESSAGE,
        );
      }
      if (
        input.currency !== undefined &&
        input.currency.trim().toUpperCase() !== report.link.currency
      ) {
        throw unprocessable(
          OPENING_BALANCE_CURRENCY_FIXED_CODE,
          OPENING_BALANCE_CURRENCY_FIXED_MESSAGE,
        );
      }
    }
    const rateOverrideReason = input.rateOverrideReason?.trim() || null;
    if (
      input.rateOverride !== undefined &&
      (rateOverrideReason === null ||
        rateOverrideReason.length > RATE_OVERRIDE_REASON_MAX)
    ) {
      throw new BadRequestException(RATE_OVERRIDE_REASON_MESSAGE);
    }
    const paymentMethodId = input.paymentMethodId ?? report.paymentMethodId;
    const method = await this.methods.findById(paymentMethodId);
    if (!method)
      throw new BadRequestException(PAYMENT_METHOD_NOT_FOUND_MESSAGE);
    // El comprobante del reporte pasa al abono salvo que el medio corregido
    // no admita comprobante (se queda solo en el reporte).
    const proof = method.proofPolicy === 'NONE' ? null : report.proof;
    const reference =
      input.reference === undefined
        ? report.reference
        : input.reference?.trim() || null;
    const paymentInput: RecordPaymentInput = {
      amount: input.amount ?? report.amount,
      currency: (input.currency ?? report.currency).trim().toUpperCase(),
      // El día civil del pago reportado: la tasa congelada es la de ese día.
      paidAt: input.paidOn ?? report.paidOn,
      paymentMethodId,
      ...(reference !== null ? { reference } : {}),
      ...(input.duplicateReferenceReason
        ? { duplicateReferenceReason: input.duplicateReferenceReason }
        : {}),
      ...(proof ? { proofUploadId: proof.uploadId } : {}),
    };
    const corrected = CORRECTABLE.filter((field) => {
      if (input[field] === undefined) return false;
      if (field === 'reference') return reference !== report.reference;
      if (field === 'currency')
        return paymentInput.currency !== report.currency;
      return input[field] !== report[field];
    });
    const changedFields = [
      ...corrected,
      ...(input.rateOverride !== undefined ? ['rateOverride'] : []),
      ...(input.duplicateReferenceReason ? ['duplicateReferenceReason'] : []),
    ];

    const now = this.clock();
    const hook: PaymentInsertHook = async (tx, payment) => {
      const confirmed = await this.repo.confirmInTx(tx, {
        reportId: report.id,
        paymentId: payment.id,
        decidedById: audit.actor.userId,
        now,
      });
      // Rechazado (o confirmado) entre la lectura y aquí: se deshace el abono.
      if (!confirmed) throw notPending();
      const actor = {
        kind: 'user' as const,
        userId: audit.actor.userId,
        role: audit.actor.role,
      };
      const common = {
        tenantId: audit.tenantId,
        locationId: report.locationId,
        actor,
        patient: { kind: 'patient' as const, id: report.patientId },
        requestId: audit.requestId,
        ip: audit.ip,
        userAgent: audit.userAgent,
      };
      // Cada corrección queda en la auditoría (los nombres, nunca valores).
      await writeAuditEvent(tx, {
        ...common,
        action: 'UPDATE',
        resourceType: 'PAYMENT_REPORT',
        resourceId: report.id,
        metadata: {
          reason: PAYMENT_REPORT_CONFIRMED_REASON,
          statusChange: { from: 'PENDING', to: 'CONFIRMED' },
          params: { paymentId: payment.id },
          ...(changedFields.length > 0 ? { changedFields } : {}),
          // La tasa que fijó recepción y su motivo (revisión del PR #176).
          ...(input.rateOverride !== undefined && rateOverrideReason
            ? {
                rateOverride: {
                  rate: rateText(input.rateOverride),
                  reason: rateOverrideReason,
                },
              }
            : {}),
        },
      });
      await writeAuditEvent(tx, {
        ...common,
        action: 'CREATE',
        resourceType: 'PAYMENT',
        resourceId: payment.id,
        metadata: {
          // DX-136: el recibo numerado nace con el abono.
          reason: 'RECEIPT_ISSUED',
          params: { reportId: report.id },
        },
      });
    };

    try {
      const options = { proof: proof ?? null, afterInsertInTx: hook };
      const payment = report.link.treatmentPlanId
        ? await this.recordPayment.execute(
            report.link.treatmentPlanId,
            paymentInput,
            audit.actor.userId,
            report.id,
            {
              ...options,
              ...(input.rateOverride !== undefined
                ? { rateOverride: input.rateOverride }
                : {}),
            },
          )
        : await this.recordBalancePayment.execute(
            report.link.openingBalanceId!,
            paymentInput,
            audit.actor.userId,
            report.id,
            options,
          );
      return { reportId: report.id, status: 'CONFIRMED', payment };
    } catch (error) {
      // La otra confirmación (a la vez, o repetida con otras correcciones)
      // ganó: devuelve su abono, nunca un segundo.
      const now = await this.repo.findReport(report.id).catch(() => null);
      if (now?.status === 'CONFIRMED') return this.alreadyConfirmed(now);
      throw error;
    }
  }

  private async alreadyConfirmed(
    report: PaymentReportRow,
  ): Promise<ConfirmedPaymentReport> {
    const found = await this.payments.findByIdempotencyKey(report.id);
    if (!found || found.payment.id !== report.paymentId) {
      // No debería pasar (la clave es el id del reporte): solo ids al log.
      this.logger.error({
        event: 'payment_reports.confirmed_without_payment',
        reportId: report.id,
        requestId: currentRequestId() ?? null,
      });
      throw notPending();
    }
    return { reportId: report.id, status: 'CONFIRMED', payment: found.payment };
  }
}

/**
 * `POST /payment-reports/:id/reject` (D8): RECHAZADO con el motivo interno,
 * sin tocar el saldo. Si el paciente tiene email se le avisa SIN el motivo.
 */
@Injectable()
export class RejectPaymentReportUseCase {
  private readonly logger = new Logger('PaymentReports');

  constructor(
    @Inject(PAYMENT_LINK_REPOSITORY)
    private readonly repo: PaymentLinkRepository,
    @Inject(PAYMENT_LINK_EMAILS) private readonly emails: PaymentLinkEmails,
    private readonly tenantContext: TenantContextService,
    @Inject(PAYMENT_LINKS_CLOCK) private readonly clock: PaymentLinksClock,
  ) {}

  async execute(
    id: string,
    reason: string,
    audit: AuditRequestContext,
  ): Promise<{ report: PaymentReportRow; patientNotified: boolean }> {
    const text = reason.trim();
    if (text.length === 0 || text.length > REJECT_REASON_MAX) {
      throw new BadRequestException(REJECT_REASON_MESSAGE);
    }
    await loadReport(this.repo, this.tenantContext, id);
    const outcome = await this.repo.rejectReport({
      reportId: id,
      reason: text,
      now: this.clock(),
      audit,
    });
    if (outcome.kind === 'NOT_FOUND') {
      throw new NotFoundException(PAYMENT_REPORT_NOT_FOUND_MESSAGE);
    }
    if (outcome.kind === 'NOT_PENDING') throw notPending();
    const { report } = outcome;
    return { report, patientNotified: await this.notify(report) };
  }

  /** El aviso nunca falla el rechazo (ya está confirmado): solo ids al log. */
  private async notify(report: PaymentReportRow): Promise<boolean> {
    try {
      const contact = await this.repo.patientContact(report.patientId);
      const email = contact?.email?.trim();
      if (!contact || !email) return false;
      await this.emails.sendRejected({
        to: email,
        reportId: report.id,
        vars: {
          patientFirstName: firstNameOnly(contact.firstName),
          clinicName: await this.clinicName(),
        },
      });
      return true;
    } catch (error) {
      this.logger.warn({
        event: 'payment_reports.reject_notice_failed',
        reportId: report.id,
        error: error instanceof Error ? error.name : 'NonError',
      });
      return false;
    }
  }

  private async clinicName(): Promise<string> {
    return this.repo.clinicName();
  }
}
