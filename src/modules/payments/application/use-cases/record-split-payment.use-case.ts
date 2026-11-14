import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ReceiptPlanBalanceCalculator } from '../receipts/receipt-plan-balance';
import { IDEMPOTENCY_KEY_INVALID_MESSAGE } from '../../../../shared/validation/idempotency-key';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
import type {
  CreatePaymentRepoInput,
  ReceiptExcessGuardInTx,
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
  SPLIT_PAYMENT_BALANCE_UNAVAILABLE,
  SPLIT_PAYMENT_BALANCE_UNAVAILABLE_MESSAGE,
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
import { PROOF_DUPLICATE_LINES_MESSAGE } from '../../domain/payment-proof';
import { PaymentProofs, attachmentOf } from '../payment-proofs';
import type { CompletedProof } from '../payment-proof-uploads';
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
  /** DX-389: subida del comprobante de ESTA línea (cada línea, el suyo). */
  proofUploadId?: string;
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
    // DX-389: el comprobante de cada línea (subida directa ya hecha).
    private readonly proofs: PaymentProofs,
    // DX-182: el saldo del recibo, recalculado en la transacción del cobro.
    private readonly receiptBalance: ReceiptPlanBalanceCalculator,
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
        throw new BadRequestException(IDEMPOTENCY_KEY_INVALID_MESSAGE);
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
    // DX-389: cada forma de pago lleva su propia subida (400 antes de tocar nada).
    const uploads = input.lines.flatMap((l) =>
      l.proofUploadId ? [l.proofUploadId.toLowerCase()] : [],
    );
    if (new Set(uploads).size !== uploads.length) {
      throw new BadRequestException(PROOF_DUPLICATE_LINES_MESSAGE);
    }
    const currencies: string[] = [];
    for (const line of input.lines) {
      if (!line.paymentMethodId) {
        throw new BadRequestException(SPLIT_LINE_METHOD_REQUIRED_MESSAGE);
      }
      currencies.push(await this.recordPayment.validCurrency(line));
    }
    const paidAt = await this.recordPayment.checkedPaidAt(input.paidAt);

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
    const planMovementsSeen = confirmCreditBalance
      ? undefined
      : await this.repo.countPlanMovements(treatmentPlanId);
    const receiptPlanBalance = await this.balanceAfter(
      treatmentPlanId,
      converted,
      confirmCreditBalance,
    );

    // DX-389: lo último antes de la transacción; si una línea falla, se
    // limpian las copias de las anteriores.
    const completed: (CompletedProof | null)[] = [];
    try {
      for (const { method } of prepared) {
        completed.push(
          await this.proofs.complete(method.proofUploadId, createdById),
        );
      }
    } catch (error) {
      await this.proofs.settle(completed, false);
      throw error;
    }

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
        proof: attachmentOf(completed[index]),
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

    let record: SplitPaymentRecord;
    try {
      record = await this.repo.createSplit({
        lines,
        idempotencyKey: key,
        requestFingerprint: key === undefined ? undefined : requestFingerprint,
        receiptPlanBalance,
        // DX-182: el saldo del recibo, recalculado con el plan bloqueado.
        receiptBalanceInTx: this.receiptBalance.inTransaction,
        ...(planMovementsSeen === undefined
          ? {}
          : {
              balanceGuard: { planMovementsSeen },
              // DX-463 (L4): y lo pendiente de AHORA, con el plan bloqueado.
              excessGuardInTx: this.excessGuard(converted),
            }),
      });
    } catch (error) {
      await this.proofs.settle(completed, false);
      throw error;
    }
    await this.proofs.settle(completed, true);
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
          proofUploadId: line.proofUploadId,
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
   * (`balanceGuard`). DX-463: si el saldo no se puede leer (o el proveedor de
   * tasas tardó), sin `confirmCreditBalance` es 503 y no se registra nada: ya
   * no se salta la comprobación del excedente. Con el excedente confirmado no
   * hay nada que comprobar y el cobro sigue, sin saldo en el recibo. Si alguna
   * línea está «sin tasa», el recibo sale sin saldo.
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
      // DX-463 (L3): un 404/409 (p. ej. el plan se retiró entre medias) sale
      // tal cual; solo un fallo genuino de lectura es 503.
      if (error instanceof HttpException) throw error;
      this.logger.warn({
        event: 'payment_receipt.balance_unavailable',
        error: errorName(error),
      });
      return this.unavailable(confirmCreditBalance);
    }
    // DX-054: proveedor de tasas fuera de plazo → `paid` previo incompleto,
    // como un saldo ilegible (DX-463: sin confirmar, 503).
    if (before.rateProviderTimedOut) {
      this.logger.warn({
        event: 'payment_receipt.balance_unavailable',
        error: 'RateProviderTimedOut',
      });
      return this.unavailable(confirmCreditBalance);
    }
    const known = knownSplitTotal(converted);
    if (!confirmCreditBalance && exceedsPending(known, before.balance)) {
      throw exceedsBalance(before.planCurrency, known, before.balance);
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
   * DX-463 (L4): la comprobación del excedente DENTRO de la transacción, con
   * la misma cuenta del saldo del plan sobre la foto bajo el bloqueo. Sin red
   * (`offline`); con abonos sin tasa se comprueba contra lo CONOCIDO.
   */
  private excessGuard(converted: (number | null)[]): ReceiptExcessGuardInTx {
    return async ({ planId, snapshot, creditMovements }) => {
      const now = await this.getPlanBalance.fromSnapshot(
        planId,
        snapshot,
        creditMovements,
        { offline: true },
      );
      // Un abono «sin tasa» (anterior a DX-375 o MISSING) no suma en `paid`:
      // solo puede REDUCIR lo pendiente, así que un excedente sobre lo
      // conocido es real y se rechaza igual; si no lo hay, sigue (el conteo
      // de `balanceGuard` ya se comprobó). Nunca 503 aquí.
      const known = knownSplitTotal(converted);
      if (exceedsPending(known, now.balance)) {
        throw exceedsBalance(now.planCurrency, known, now.balance);
      }
    };
  }

  /** Sin saldo legible: 503 si hacía falta comprobar el excedente; si no, sin saldo en el recibo. */
  private unavailable(confirmCreditBalance: boolean): null {
    if (confirmCreditBalance) return null;
    throw new ServiceUnavailableException({
      statusCode: 503,
      error: 'Service Unavailable',
      code: SPLIT_PAYMENT_BALANCE_UNAVAILABLE,
      message: SPLIT_PAYMENT_BALANCE_UNAVAILABLE_MESSAGE,
    });
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

/** El 409 del excedente sobre lo pendiente (con las cifras de ese momento). */
function exceedsBalance(
  currency: string,
  known: number,
  balance: number,
): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: SPLIT_PAYMENT_EXCEEDS_BALANCE,
    message: SPLIT_PAYMENT_EXCEEDS_BALANCE_MESSAGE,
    currency,
    total: known,
    pending: Math.max(0, balance),
    excess: excessOverPending(known, balance),
  });
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
