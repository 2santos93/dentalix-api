import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
import type {
  CreatePaymentRepoInput,
  PaymentRepository,
  SplitPaymentRecord,
} from '../../domain/ports/payment-repository.port';
import type { Payment } from '../../domain/entities/payment.entity';
import {
  IDEMPOTENCY_KEY_REUSED_MESSAGE,
  isSameRequest,
  splitPaymentRequestFingerprint,
} from '../../domain/idempotency';
import {
  SPLIT_LINE_METHOD_REQUIRED_MESSAGE,
  SPLIT_LINES_COUNT_MESSAGE,
  SPLIT_LINES_SAME_REFERENCE_MESSAGE,
  SPLIT_MAX_LINES,
  SPLIT_MIN_LINES,
  SPLIT_PAYMENT_EXCEEDS_BALANCE,
  SPLIT_PAYMENT_EXCEEDS_BALANCE_MESSAGE,
  exceedsPending,
  excessOverPending,
  knownSplitTotal,
  splitTotal,
} from '../../domain/split-payment';
import type { ReceiptPlanBalance } from '../../domain/receipt-snapshot';
import { PAYMENT_REFERENCE_DUPLICATE } from '../../../payment-methods/domain/payment-method-rules';
import {
  isPlanBillable,
  notBillableMessage,
} from '../../../treatment-plans/domain/plan-status-machine';
import { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import { convertWithQuote } from '../../../exchange/domain/exchange-rate-quote';
import { errorName } from '../payment-in-plan-currency';
import { GetPlanBalanceUseCase } from './get-plan-balance.use-case';
import {
  RecordPaymentUseCase,
  UUID_RE,
  normalizePaidAt,
  type PreparedPaymentLine,
} from './record-payment.use-case';
import { round2 } from '../../../../shared/money/money';

/** Una forma de pago del cobro: su medio, su moneda, su importe, su referencia. */
export interface SplitPaymentLineInput {
  amount: number;
  currency: string;
  /** Medio ACTIVO de la clínica (obligatorio en cada línea). */
  paymentMethodId: string;
  reference?: string;
  /** Motivo para confirmar la referencia repetida de ESTA línea (DX-377). */
  duplicateReferenceReason?: string;
}

// Sin `patientId`/`treatmentPlanId`/`createdById`, como RecordPaymentInput.
export interface RecordSplitPaymentInput {
  /** El mismo día (o instante) para todo el cobro (DX-097). */
  paidAt: string | Date;
  notes?: string;
  lines: SplitPaymentLineInput[];
  /** Confirma que el excedente sobre lo pendiente queda como saldo a favor. */
  confirmCreditBalance?: boolean;
}

/** El cobro registrado: sus líneas, su recibo y su total en la moneda del plan. */
export interface SplitPaymentResult {
  /** El id del cobro: el de su línea 1. */
  id: string;
  receiptNumber: string | null;
  planCurrency: string;
  /** Suma de las líneas en la moneda del plan; `null` si alguna está «sin tasa». */
  total: number | null;
  payments: Payment[];
}

/**
 * DX-390: un cobro dividido en varias formas de pago (2–5) con UN recibo. Cada
 * línea pasa por las MISMAS validaciones que un abono suelto
 * (`RecordPaymentUseCase.prepareLine`: medio de la clínica, referencia y
 * aviso de repetida, tasa congelada de su moneda) y el repositorio inserta
 * todas y el recibo en una sola transacción. Una Idempotency-Key para el
 * cobro entero. Si el total, en la moneda del plan, supera lo pendiente, 409
 * `SPLIT_PAYMENT_EXCEEDS_BALANCE` salvo `confirmCreditBalance`.
 */
@Injectable()
export class RecordSplitPaymentUseCase {
  private readonly logger = new Logger('PaymentReceipts');

  constructor(
    @Inject(PAYMENT_REPOSITORY)
    private readonly repo: PaymentRepository,
    private readonly getTreatmentPlan: GetTreatmentPlanUseCase,
    private readonly recordPayment: RecordPaymentUseCase,
    private readonly getPlanBalance: GetPlanBalanceUseCase,
  ) {}

  async execute(
    treatmentPlanId: string,
    input: RecordSplitPaymentInput,
    createdById?: string,
    idempotencyKey?: string,
  ): Promise<SplitPaymentResult> {
    // Como el abono suelto: la repetición, ANTES de validar nada.
    const key = idempotencyKey?.trim() ? idempotencyKey.trim() : undefined;
    const requestFingerprint = splitPaymentRequestFingerprint(
      treatmentPlanId,
      input,
    );
    if (key !== undefined) {
      if (!UUID_RE.test(key)) {
        throw new BadRequestException('Idempotency-Key must be a UUID');
      }
      const replay = await this.replay(
        key,
        treatmentPlanId,
        requestFingerprint,
      );
      if (replay) return replay;
    }

    if (
      input.lines.length < SPLIT_MIN_LINES ||
      input.lines.length > SPLIT_MAX_LINES
    ) {
      throw new BadRequestException(SPLIT_LINES_COUNT_MESSAGE);
    }
    const currencies: string[] = [];
    for (const line of input.lines) {
      if (!line.paymentMethodId) {
        throw new BadRequestException(SPLIT_LINE_METHOD_REQUIRED_MESSAGE);
      }
      currencies.push(await this.recordPayment.validCurrency(line));
    }
    const paidAt = this.recordPayment.checkedPaidAt(input.paidAt);

    const plan = await this.getTreatmentPlan.execute(treatmentPlanId);
    if (!isPlanBillable(plan.status)) {
      throw new ConflictException(notBillableMessage(plan.status));
    }

    const prepared: PreparedPaymentLine[] = [];
    for (const [index, line] of input.lines.entries()) {
      prepared.push(
        await this.prepareLine(plan, line, currencies[index], paidAt, index),
      );
    }
    assertDistinctReferences(prepared);

    const converted = prepared.map((line) => line.converted);
    const confirmCreditBalance = input.confirmCreditBalance === true;
    // Revisión DX-390: lo pendiente se lee fuera de la transacción. Sin la
    // confirmación, cuántos abonos tenía el plan ANTES de leerlo: la
    // transacción bloquea el plan y, si llegó otro (dos cobros a la vez), 409
    // sin registrar nada, en vez de dejar un saldo a favor sin confirmar.
    const planPaymentsSeen = confirmCreditBalance
      ? undefined
      : await this.repo.countPlanPayments(treatmentPlanId);
    const receiptPlanBalance = await this.balanceAfter(
      treatmentPlanId,
      converted,
      confirmCreditBalance,
    );

    const lines: CreatePaymentRepoInput[] = input.lines.map((line, index) => {
      const { method, paidOn, frozenRate } = prepared[index];
      const amount = converted[index];
      return {
        treatmentPlanId,
        openingBalanceId: null,
        patientId: plan.patientId,
        amount: line.amount,
        currency: currencies[index],
        paidAt,
        method: method.method,
        paymentMethodId: method.paymentMethodId,
        reference: method.reference,
        referenceNormalized: method.referenceNormalized,
        duplicateReferenceReason: method.duplicateReferenceReason,
        // DX-516: cada parte, con los ajustes de su propio medio.
        adjustments: method.adjustments,
        notes: input.notes,
        createdById,
        receiptPlanBalance: null,
        planAmount:
          amount === null
            ? null
            : { planCurrency: plan.currency, amount, rateDate: paidOn },
        frozenRate,
      };
    });

    const record = await this.repo.createSplit({
      lines,
      idempotencyKey: key,
      requestFingerprint: key === undefined ? undefined : requestFingerprint,
      receiptPlanBalance,
      ...(planPaymentsSeen === undefined
        ? {}
        : { balanceGuard: { planPaymentsSeen } }),
    });
    const result = this.toResult(record, plan.currency);
    return {
      ...result,
      payments: result.payments.map((payment, index) => ({
        ...payment,
        duplicateReferenceOf:
          prepared[index]?.method.duplicateReferenceOf ?? [],
      })),
    };
  }

  /**
   * El cobro original si la clave ya se usó para ESTE cobro (mismo plan y
   * cuerpo); 422 si se usó para otra cosa (otro cobro o un abono suelto).
   */
  private async replay(
    key: string,
    treatmentPlanId: string,
    requestFingerprint: string,
  ): Promise<SplitPaymentResult | null> {
    const existing = await this.repo.findByIdempotencyKey(key);
    if (!existing) return null;
    const head = existing.payment;
    const split =
      head.splitId === head.id &&
      isSameRequest(existing, treatmentPlanId, requestFingerprint)
        ? await this.repo.findSplit(head.id)
        : null;
    if (!split) {
      throw new UnprocessableEntityException(IDEMPOTENCY_KEY_REUSED_MESSAGE);
    }
    return this.toResult(split, head.exchangeRateCurrency ?? head.currency);
  }

  /**
   * `prepareLine` de un abono suelto; el 409 de referencia repetida dice qué
   * línea es (`line`, desde 0) para que la pantalla pida el motivo en ella.
   */
  private async prepareLine(
    plan: { currency: string },
    line: SplitPaymentLineInput,
    currency: string,
    paidAt: ReturnType<typeof normalizePaidAt>,
    index: number,
  ): Promise<PreparedPaymentLine> {
    try {
      return await this.recordPayment.prepareLine(
        plan,
        {
          amount: line.amount,
          paymentMethodId: line.paymentMethodId,
          reference: line.reference,
          duplicateReferenceReason: line.duplicateReferenceReason,
        },
        currency,
        paidAt,
      );
    } catch (error) {
      if (
        error instanceof ConflictException &&
        (error.getResponse() as { code?: unknown }).code ===
          PAYMENT_REFERENCE_DUPLICATE
      ) {
        throw new ConflictException({
          ...(error.getResponse() as object),
          line: index,
        });
      }
      throw error;
    }
  }

  /**
   * Saldo del plan tras el cobro, para el recibo, y la regla del saldo a
   * favor: con lo que se sabe del total (las líneas con tasa), si supera lo
   * pendiente hace falta `confirmCreditBalance` (409). Como el saldo del
   * recibo de un abono suelto, se lee fuera de la transacción; la
   * transacción comprueba que ningún abono llegó entretanto
   * (`balanceGuard`). Si el saldo no se puede leer,
   * el cobro sigue (sin saldo en el recibo); si alguna línea está «sin tasa»,
   * el recibo sale sin saldo.
   */
  private async balanceAfter(
    treatmentPlanId: string,
    converted: (number | null)[],
    confirmCreditBalance: boolean,
  ): Promise<ReceiptPlanBalance | null> {
    let before: Awaited<ReturnType<GetPlanBalanceUseCase['execute']>>;
    try {
      before = await this.getPlanBalance.execute(treatmentPlanId);
    } catch (error) {
      this.logger.warn({
        event: 'payment_receipt.balance_unavailable',
        error: errorName(error),
      });
      return null;
    }
    // DX-054: proveedor de tasas fuera de plazo → `paid` previo incompleto:
    // ni guarda de exceso ni saldo en el recibo (como un saldo ilegible).
    if (before.rateProviderTimedOut) {
      this.logger.warn({
        event: 'payment_receipt.balance_unavailable',
        error: 'RateProviderTimedOut',
      });
      return null;
    }
    const known = knownSplitTotal(converted);
    if (!confirmCreditBalance && exceedsPending(known, before.balance)) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: SPLIT_PAYMENT_EXCEEDS_BALANCE,
        message: SPLIT_PAYMENT_EXCEEDS_BALANCE_MESSAGE,
        currency: before.planCurrency,
        total: known,
        pending: Math.max(0, before.balance),
        excess: excessOverPending(known, before.balance),
      });
    }
    const total = splitTotal(converted);
    if (total === null) return null;
    const paid = round2(before.paid + total);
    return {
      currency: before.planCurrency,
      billable: before.billable,
      paid,
      balance: round2(before.billable - paid - before.creditMovements),
    };
  }

  /**
   * El total sale de cada línea con SU tasa congelada (la misma cifra al
   * registrar y al repetir la petición, sin pedir ninguna tasa); una «sin
   * tasa» deja el total en `null`.
   */
  private toResult(
    record: SplitPaymentRecord,
    planCurrency: string,
  ): SplitPaymentResult {
    return {
      id: record.splitId,
      receiptNumber: record.receiptNumber,
      planCurrency,
      total: splitTotal(
        record.payments.map((payment) => frozenAmountIn(payment, planCurrency)),
      ),
      payments: record.payments,
    };
  }
}

/** La línea en la moneda del plan con su tasa congelada; `null` sin ella. */
function frozenAmountIn(payment: Payment, planCurrency: string): number | null {
  if (payment.currency === planCurrency) return payment.amount;
  const frozen = payment.frozenRate;
  if (!frozen || frozen.currency !== planCurrency) return null;
  return convertWithQuote(payment.amount, {
    from: payment.currency,
    to: planCurrency,
    fromPerBase: frozen.fromPerBase,
    toPerBase: frozen.toPerBase,
  });
}

/** Dos líneas con el mismo medio y la misma referencia son un error de la caja. */
function assertDistinctReferences(lines: PreparedPaymentLine[]): void {
  const seen = new Set<string>();
  for (const { method } of lines) {
    if (!method.paymentMethodId || !method.referenceNormalized) continue;
    const key = `${method.paymentMethodId}|${method.referenceNormalized}`;
    if (seen.has(key)) {
      throw new BadRequestException(SPLIT_LINES_SAME_REFERENCE_MESSAGE);
    }
    seen.add(key);
  }
}
