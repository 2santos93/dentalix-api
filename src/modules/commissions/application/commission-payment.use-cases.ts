import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PaymentMethod } from '@prisma/client';
import {
  generatePublicLinkToken,
  hashPublicLinkToken,
} from '../../../shared/public-links/public-link-token';
import { toCents } from '../../../shared/money/money';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { CreateExpenseUseCase } from '../../expenses/application/use-cases/create-expense.use-case';
import { VoidExpenseUseCase } from '../../expenses/application/use-cases/void-expense.use-case';
import { rule } from '../../expenses/application/guarded';
import { validateVoidReason } from '../../expenses/domain/expense-rules';
import {
  buildReceiptContent,
  receiptContentHash,
  receiptDocumentModel,
  settlementDocumentModel,
} from '../domain/commission-receipt';
import {
  COMMISSION_CLOCK,
  type CommissionClock,
} from '../domain/ports/commission-repository.port';
import {
  COMMISSION_PAYMENT_REPOSITORY,
  type CommissionPaymentRepository,
  type PaymentRecord,
} from '../domain/ports/commission-payment-repository.port';
import {
  PAYMENT_PLAN_MESSAGES,
  PAYMENT_REFERENCE_MESSAGE,
  expenseDescription,
  parsePaymentReference,
  planPayment,
  type PaymentPlanError,
} from '../domain/settlement-payments';
import type { CommissionPaymentView } from '../domain/views';
import {
  COMMISSION_PDF_RENDERER,
  type CommissionPdfRenderer,
} from '../infrastructure/commission-pdf.renderer';
import {
  alreadyPaidConflict,
  paymentVoidedConflict,
} from '../infrastructure/prisma-commission-payment.repository';
import {
  COMMISSION_MESSAGES,
  type CommissionActor,
} from './commission.use-cases';

/** La categoría predefinida del gasto (DX-274): «Honorarios». */
export const COMMISSION_EXPENSE_CATEGORY = 'Honorarios';
/** Vigencia del enlace de conformidad (como la firma a distancia, DX-243). */
export const COMMISSION_RECEIPT_TTL_HOURS = 72;
/** Ruta pública de la web (src/app/(public)/conformidad/[token]). */
export const COMMISSION_RECEIPT_PUBLIC_PATH = '/conformidad';

export const COMMISSION_PAYMENT_MESSAGES = {
  paymentNotFound: 'Pago de honorarios no encontrado.',
  currency: 'Indica la moneda del pago (código de 3 letras).',
  noHost:
    'No se pudo armar el enlace desde esta dirección. Abre Dentalix desde la dirección de tu clínica y vuelve a intentarlo.',
  lockedCreate:
    'La fecha del pago cae en un período contable cerrado (al cerrar la liquidación el cierre sube hasta su último día). Elige una fecha posterior al cierre.',
  lockedVoid:
    'El pago es de un período contable cerrado: ya no se puede anular. Pide a administración que revise el cierre contable.',
} as const;

const HOUR_MS = 60 * 60 * 1000;

function planError(error: PaymentPlanError): Error {
  const body = {
    error: 'Conflict',
    code: error.code,
    message: PAYMENT_PLAN_MESSAGES[error.code],
    ...(error.code === 'COMMISSION_PAYMENT_EXCEEDS_PENDING'
      ? { pending: error.pending }
      : {}),
  };
  switch (error.code) {
    case 'COMMISSION_PAYMENT_LINE_UNKNOWN':
    case 'COMMISSION_PAYMENT_LINE_CURRENCY':
    case 'COMMISSION_PAYMENT_NOT_POSITIVE':
      return new BadRequestException({
        ...body,
        statusCode: 400,
        error: 'Bad Request',
      });
    default:
      return new ConflictException({ ...body, statusCode: 409 });
  }
}

export interface PayCommissionInput {
  currency: string;
  lineIds?: string[];
  paidOn: string;
  method: PaymentMethod;
  reference?: string | null;
  locationId?: string;
  fromCashSession?: boolean;
}

export interface CommissionPdf {
  filename: string;
  pdf: Buffer;
}

export interface CommissionReceiptLink {
  /** La URL con el token: solo en esta respuesta (no se guarda). */
  url: string;
  expiresAt: Date;
}

/**
 * DX-464: pagar una liquidación cerrada (gasto de la sede en la misma
 * transacción), anular el pago, sus PDF y el enlace de conformidad. Solo
 * ADMIN con todas las sedes (las liquidaciones son de toda la clínica).
 */
@Injectable()
export class CommissionPaymentUseCases {
  constructor(
    @Inject(COMMISSION_PAYMENT_REPOSITORY)
    private readonly repo: CommissionPaymentRepository,
    private readonly createExpense: CreateExpenseUseCase,
    private readonly voidExpense: VoidExpenseUseCase,
    private readonly tenantContext: TenantContextService,
    @Inject(COMMISSION_PDF_RENDERER)
    private readonly renderer: CommissionPdfRenderer,
    @Inject(COMMISSION_CLOCK) private readonly now: CommissionClock,
  ) {}

  private assertClinicWide(): void {
    if (this.tenantContext.getAllowedLocationIds() !== 'ALL') {
      throw new ForbiddenException(COMMISSION_MESSAGES.allLocations);
    }
  }

  private async header(settlementId: string) {
    const header = await this.repo.header(settlementId);
    if (!header) {
      throw new NotFoundException(COMMISSION_MESSAGES.settlementNotFound);
    }
    return header;
  }

  private async payment(paymentId: string): Promise<PaymentRecord> {
    const payment = await this.repo.findPayment(paymentId);
    if (!payment) {
      throw new NotFoundException(COMMISSION_PAYMENT_MESSAGES.paymentNotFound);
    }
    return payment;
  }

  private async paymentView(
    settlementId: string,
    paymentId: string,
  ): Promise<CommissionPaymentView> {
    const view = (await this.repo.payments(settlementId)).find(
      (p) => p.id === paymentId,
    );
    if (!view) {
      throw new NotFoundException(COMMISSION_PAYMENT_MESSAGES.paymentNotFound);
    }
    return view;
  }

  async payments(
    _actor: CommissionActor,
    settlementId: string,
  ): Promise<CommissionPaymentView[]> {
    this.assertClinicWide();
    await this.header(settlementId);
    return this.repo.payments(settlementId);
  }

  /**
   * Registra el pago de las líneas elegidas (o de todas las pendientes de la
   * moneda) y crea su gasto en la sede. Comprueba antes, fuera de la
   * transacción, para no tocar nada si no vale; y otra vez dentro, con la
   * liquidación bloqueada, por si otro pago se adelantó.
   */
  async pay(
    actor: CommissionActor,
    settlementId: string,
    input: PayCommissionInput,
    ctx: AuditRequestContext,
  ): Promise<CommissionPaymentView> {
    this.assertClinicWide();
    const header = await this.header(settlementId);
    const currency = (input.currency ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new BadRequestException(COMMISSION_PAYMENT_MESSAGES.currency);
    }
    const reference = parsePaymentReference(input.reference);
    if (!reference.ok) throw new BadRequestException(PAYMENT_REFERENCE_MESSAGE);
    const planned = planPayment(
      await this.repo.payableLines(settlementId),
      currency,
      input.lineIds,
    );
    if (!planned.ok) throw planError(planned.error);
    const plan = planned.plan;

    let paymentId: string | null = null;
    await this.createExpense.createIdempotent(
      {
        locationId: input.locationId,
        category: COMMISSION_EXPENSE_CATEGORY,
        supplier: header.professionalName.slice(0, 200),
        description: expenseDescription(header.period, reference.value),
        amount: plan.amount,
        currency,
        invoiceDate: input.paidOn,
        payment: {
          amount: plan.amount,
          method: input.method,
          paidOn: input.paidOn,
          fromCashSession: input.fromCashSession,
        },
      },
      actor.userId,
      undefined,
      undefined,
      undefined,
      async (tx, expense) => {
        await this.repo.lockSettlement(tx, settlementId);
        const again = planPayment(
          await this.repo.payableLinesIn(tx, settlementId),
          currency,
          plan.lineIds,
        );
        if (!again.ok) throw planError(again.error);
        if (toCents(again.plan.amount) !== toCents(plan.amount)) {
          throw alreadyPaidConflict();
        }
        await this.repo.assertDayOpen(
          tx,
          input.paidOn,
          expense.locationId,
          'PAYMENT_CREATE',
          COMMISSION_PAYMENT_MESSAGES.lockedCreate,
        );
        paymentId = await this.repo.insertPayment(
          tx,
          {
            settlementId,
            userId: header.userId,
            locationId: expense.locationId,
            currency,
            amount: plan.amount,
            method: input.method,
            paidOn: input.paidOn,
            reference: reference.value,
            expenseId: expense.id,
            lineIds: plan.lineIds,
            createdById: actor.userId,
          },
          ctx,
        );
      },
    );
    if (paymentId === null) {
      // El alta del gasto siempre corre el gancho; sin él, error de montaje.
      throw new Error('El gasto se creó sin su pago de honorarios');
    }
    return this.paymentView(settlementId, paymentId);
  }

  /**
   * Anula el pago con motivo: su gasto (y su salida de caja, si salió de
   * ella), sus líneas (vuelven a estar pendientes) y su enlace de
   * conformidad vivo, en una transacción.
   */
  async void(
    actor: CommissionActor,
    paymentId: string,
    reason: string,
    ctx: AuditRequestContext,
  ): Promise<CommissionPaymentView> {
    this.assertClinicWide();
    const payment = await this.payment(paymentId);
    if (payment.voided) throw paymentVoidedConflict();
    const trimmed = rule(() => validateVoidReason(reason));
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    // El gasto es de SU sede: la anulación corre con ella como sede activa
    // (el ADMIN tiene todas), aunque la petición venga con otra.
    await this.tenantContext.run(tenantId, payment.locationId, () =>
      this.voidExpense.execute(
        payment.expenseId,
        trimmed,
        actor.userId,
        async (tx) => {
          await this.repo.lockSettlement(tx, payment.settlementId);
          await this.repo.assertDayOpen(
            tx,
            payment.paidOn,
            payment.locationId,
            'PAYMENT_VOID',
            COMMISSION_PAYMENT_MESSAGES.lockedVoid,
          );
          if (!(await this.repo.voidPayment(tx, payment, trimmed, ctx))) {
            throw paymentVoidedConflict();
          }
        },
      ),
    );
    return this.paymentView(payment.settlementId, payment.id);
  }

  /** PDF de la liquidación: iniciales, procedimiento, fecha, base, % y totales por moneda. */
  async settlementPdf(
    _actor: CommissionActor,
    settlementId: string,
  ): Promise<CommissionPdf> {
    this.assertClinicWide();
    const source = await this.repo.settlementDocument(settlementId);
    if (!source) {
      throw new NotFoundException(COMMISSION_MESSAGES.settlementNotFound);
    }
    const pdf = await this.renderer.render(
      settlementDocumentModel(source, this.now()),
    );
    const { from, to } = source.header.period;
    return { filename: `liquidacion-honorarios-${from}-${to}.pdf`, pdf };
  }

  /**
   * PDF del recibo de un pago; si el profesional ya firmó, el firmado (la
   * foto que firmó, con fecha, IP, navegador, firma y huellas).
   */
  async receiptPdf(
    _actor: CommissionActor,
    paymentId: string,
  ): Promise<CommissionPdf> {
    this.assertClinicWide();
    const payment = await this.payment(paymentId);
    const source = await this.repo.settlementDocument(payment.settlementId);
    if (!source) {
      throw new NotFoundException(COMMISSION_MESSAGES.settlementNotFound);
    }
    const signed = await this.repo.signedReceipt(paymentId);
    const view = source.payments.find((p) => p.id === paymentId);
    if (!view) {
      throw new NotFoundException(COMMISSION_PAYMENT_MESSAGES.paymentNotFound);
    }
    const model =
      signed && signed.signedAt && signed.signature && signed.receiptHash
        ? receiptDocumentModel(
            signed.content,
            {
              signerName: signed.signerName ?? '',
              signature: signed.signature,
              signedAt: signed.signedAt,
              ipAddress: signed.ipAddress,
              userAgent: signed.userAgent,
              contentHash: signed.contentHash,
              receiptHash: signed.receiptHash,
            },
            source.format.timeZone,
            this.now(),
          )
        : receiptDocumentModel(
            buildReceiptContent(source, view),
            null,
            source.format.timeZone,
            this.now(),
          );
    const pdf = await this.renderer.render(model);
    const suffix = signed ? '-conforme' : '';
    return {
      filename: `recibo-honorarios-${view.paidOn}-${view.currency}${suffix}.pdf`,
      pdf,
    };
  }

  /**
   * Crea el enlace de conformidad del pago (72 h, un solo uso) con la foto
   * del recibo. Pedir otro revoca el anterior. La URL solo viaja en esta
   * respuesta: la web la manda por email (mailto) o WhatsApp (wa.me).
   */
  async requestReceipt(
    _actor: CommissionActor,
    paymentId: string,
    link: { protocol: string; host: string | null },
    ctx: AuditRequestContext,
  ): Promise<CommissionReceiptLink> {
    this.assertClinicWide();
    if (!link.host) {
      throw new BadRequestException(COMMISSION_PAYMENT_MESSAGES.noHost);
    }
    const payment = await this.payment(paymentId);
    if (payment.voided) throw paymentVoidedConflict();
    const source = await this.repo.settlementDocument(payment.settlementId);
    const view = source?.payments.find((p) => p.id === paymentId);
    if (!source || !view) {
      throw new NotFoundException(COMMISSION_PAYMENT_MESSAGES.paymentNotFound);
    }
    const content = buildReceiptContent(source, view);
    const token = generatePublicLinkToken();
    const expiresAt = new Date(
      this.now().getTime() + COMMISSION_RECEIPT_TTL_HOURS * HOUR_MS,
    );
    await this.repo.createReceiptRequest(
      {
        paymentId,
        tokenHash: hashPublicLinkToken(token),
        content,
        contentHash: receiptContentHash(content),
        expiresAt,
      },
      ctx,
    );
    return {
      url: `${link.protocol}://${link.host}${COMMISSION_RECEIPT_PUBLIC_PATH}/${token}`,
      expiresAt,
    };
  }
}
