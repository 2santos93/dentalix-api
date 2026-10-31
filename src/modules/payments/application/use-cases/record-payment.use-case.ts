import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
import { PAYMENT_CLOCK, type PaymentClock } from './void-payment.use-case';
import {
  PAID_AT_IN_FUTURE_MESSAGE,
  isPaidAtTooFarInFuture,
} from '../../domain/paid-at-window';
import type {
  CivilPaidDay,
  CreatePaymentRepoInput,
  PaymentRepository,
} from '../../domain/ports/payment-repository.port';
import { parseCivilDate } from '../../../../shared/time/civil-day';
import { Payment } from '../../domain/entities/payment.entity';
import {
  IDEMPOTENCY_KEY_REUSED_MESSAGE,
  isSameRequest,
  paymentRequestFingerprint,
} from '../../domain/idempotency';
import {
  isPlanBillable,
  notBillableMessage,
} from '../../../treatment-plans/domain/plan-status-machine';
import { GetTreatmentPlanUseCase } from '../../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import { CURRENCY_WHITELIST } from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import type { CurrencyWhitelist } from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import { ReceiptPlanBalanceCalculator } from '../receipts/receipt-plan-balance';
import { ConvertAmountUseCase } from '../../../exchange/application/use-cases/convert-amount.use-case';
import { errorName } from '../payment-in-plan-currency';
import { freezePaymentRate, paymentBaseAmount } from '../payment-exchange-rate';
import type { FrozenExchangeRate } from '../../domain/payment-exchange-rate';
import {
  PaymentMethodGate,
  type PaymentMethodRequest,
  type ResolvedPaymentMethod,
} from '../payment-method-gate';

// NOTE: deliberately NO `patientId`/`treatmentPlanId` field on the input
// object itself (`treatmentPlanId` is a separate `execute()` argument,
// `patientId` is ALWAYS derived from the plan) — same convention as
// CreateSaleInput never accepting `total`/`amount` from the caller.
export interface RecordPaymentInput {
  amount: number;
  currency: string;
  /**
   * Instante (ISO con hora, o `Date`) o solo el día civil `YYYY-MM-DD`, que
   * se guarda al mediodía de la sede del abono (DX-097).
   */
  paidAt: string | Date;
  method?: PaymentMethod;
  /** DX-377: medio del catálogo de la clínica (gana a `method`). */
  paymentMethodId?: string;
  /** DX-377: referencia del pago; obligatoria si el medio la pide. */
  reference?: string;
  /** DX-377: motivo para confirmar una referencia repetida (409 sin él). */
  duplicateReferenceReason?: string;
  notes?: string;
}

/** Lo que `prepareLine` resuelve de un abono antes de su transacción. */
export interface PreparedPaymentLine {
  method: ResolvedPaymentMethod;
  /** Día civil del abono en la sede donde se registra (DX-097). */
  paidOn: string;
  frozenRate: FrozenExchangeRate | null;
  /** El abono en la moneda del plan con esa tasa; `null` sin tasa. */
  converted: number | null;
}

const CIVIL_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
// Una hora sin `Z` ni desfase la leería `new Date` en la zona del SERVIDOR.
const EXPLICIT_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * ¿Es el instante exactamente la medianoche UTC? Es lo que mandaba la web
 * anterior a DX-097 (`new Date('YYYY-MM-DD').toISOString()`) para el día
 * elegido, y la misma regla con la que la migración
 * 20261017113000_payments_civil_day_noon reinterpretó los abonos guardados.
 * Compatibilidad de escritura con pestañas abiertas con el bundle viejo:
 * retirar cuando ningún cliente anterior a DX-097 siga en uso (p. ej. un mes
 * después del despliegue, revisando el log de acceso).
 */
function isUtcMidnight(instant: Date): boolean {
  return instant.getTime() % (24 * 60 * 60 * 1000) === 0;
}

/**
 * DX-097: `YYYY-MM-DD` es un día civil (el formulario de abono), y también una
 * medianoche UTC exacta (clientes antiguos, ver `isUtcMidnight`); cualquier
 * otra fecha ISO con hora es un instante y debe traer `Z` o desfase. Sin esta
 * distinción, `new Date` leería el día como medianoche UTC, que en Bogotá es
 * la tarde del día ANTERIOR.
 */
export function normalizePaidAt(value: string | Date): Date | CivilPaidDay {
  if (typeof value === 'string' && CIVIL_DATE_SHAPE.test(value)) {
    const civilDate = parseCivilDate(value);
    if (civilDate === null) {
      throw new BadRequestException('paidAt must be a valid date');
    }
    return { civilDate };
  }
  if (typeof value === 'string' && !EXPLICIT_OFFSET.test(value.trim())) {
    throw new BadRequestException(
      'paidAt with a time must include Z or a UTC offset',
    );
  }
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new BadRequestException('paidAt must be a valid date');
  }
  if (isUtcMidnight(instant)) {
    return { civilDate: instant.toISOString().slice(0, 10) };
  }
  return instant;
}

export function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// Idempotency-Key must be a UUID (the client contract). Validated here rather
// than via a DTO because it's a header, not a body field — same reason
// tenant/createdById live outside RecordPaymentInput.
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class RecordPaymentUseCase {
  private readonly logger = new Logger('PaymentAllocations');

  constructor(
    @Inject(PAYMENT_REPOSITORY)
    private readonly repo: PaymentRepository,
    // Concrete class (not an interface port) injected directly, same
    // cross-module DI pattern as GetSalesTotalsUseCase injecting
    // ConvertAmountUseCase: reused so "does the plan exist" (NotFound if
    // absent/soft-deleted/cross-tenant) and "what's its patientId" live in
    // exactly one place, never re-implemented here.
    private readonly getTreatmentPlan: GetTreatmentPlanUseCase,
    @Inject(CURRENCY_WHITELIST)
    private readonly whitelist: CurrencyWhitelist,
    // DX-136: saldo del plan tras el abono, para la foto del recibo que el
    // repositorio emite en la misma transacción.
    private readonly receiptBalance: ReceiptPlanBalanceCalculator,
    // DX-051: la base del abono (en la moneda del plan) para la imputación.
    private readonly convertAmount: ConvertAmountUseCase,
    // DX-377: medio del catálogo, referencia y aviso de referencia repetida.
    private readonly paymentMethodGate: PaymentMethodGate,
    // DX-054: la fecha del abono no puede ir más de 24 h por delante.
    @Inject(PAYMENT_CLOCK)
    private readonly now: PaymentClock,
  ) {}

  /**
   * `normalizePaidAt` más la ventana de DX-054 (400 si va a más de 24 h en
   * el futuro). La usan el abono suelto y el repartido.
   */
  checkedPaidAt(value: string | Date): Date | CivilPaidDay {
    const paidAt = normalizePaidAt(value);
    if (isPaidAtTooFarInFuture(paidAt, this.now())) {
      throw new BadRequestException(PAID_AT_IN_FUTURE_MESSAGE);
    }
    return paidAt;
  }

  /**
   * `createdById` is a separate argument (not part of `input`) — it comes
   * from the guarded request context (`req.user`), never the client body,
   * same rationale as the tenant itself (see CreateSaleUseCase).
   */
  async execute(
    treatmentPlanId: string,
    input: RecordPaymentInput,
    createdById?: string,
    idempotencyKey?: string,
  ): Promise<Payment> {
    // Idempotency short-circuit FIRST — before any validation or plan lookup: a
    // replay must be cheap and must NOT re-run "does the plan still exist" (a
    // plan voided AFTER the original payment would otherwise make an honest
    // retry 404). Blank/whitespace header == no key (today's behavior).
    const key = idempotencyKey?.trim() ? idempotencyKey.trim() : undefined;
    const requestFingerprint = paymentRequestFingerprint(
      treatmentPlanId,
      input,
    );
    if (key !== undefined) {
      if (!UUID_RE.test(key)) {
        throw new BadRequestException('Idempotency-Key must be a UUID');
      }
      const existing = await this.repo.findByIdempotencyKey(key);
      if (existing) {
        // DX-109 (BE-017): solo la MISMA petición recibe el abono original;
        // otro plan u otro cuerpo con la misma clave es un error del cliente.
        if (!isSameRequest(existing, treatmentPlanId, requestFingerprint)) {
          throw new UnprocessableEntityException(
            IDEMPOTENCY_KEY_REUSED_MESSAGE,
          );
        }
        return existing.payment;
      }
    }

    const currency = await this.validCurrency(input);
    const paidAt = this.checkedPaidAt(input.paidAt);

    // Throws NotFoundException when the plan is absent, soft-deleted, or
    // belongs to another tenant — never re-derived here.
    const plan = await this.getTreatmentPlan.execute(treatmentPlanId);
    // Atajo con 409 limpio (DX-109); la comprobación que cuenta la repite el
    // repositorio con el plan bloqueado, en la transacción del INSERT.
    if (!isPlanBillable(plan.status)) {
      throw new ConflictException(notBillableMessage(plan.status));
    }
    const {
      method: payMethod,
      paidOn,
      frozenRate,
      converted,
    } = await this.prepareLine(plan, input, currency, paidAt);
    const receiptPlanBalance = await this.receiptBalance.afterPayment(
      treatmentPlanId,
      converted,
    );
    const planAmount =
      converted === null
        ? null
        : { planCurrency: plan.currency, amount: converted, rateDate: paidOn };

    const repoInput: CreatePaymentRepoInput = {
      treatmentPlanId,
      openingBalanceId: null,
      patientId: plan.patientId,
      amount: input.amount,
      currency,
      paidAt,
      method: payMethod.method,
      paymentMethodId: payMethod.paymentMethodId,
      reference: payMethod.reference,
      referenceNormalized: payMethod.referenceNormalized,
      duplicateReferenceReason: payMethod.duplicateReferenceReason,
      notes: input.notes,
      createdById,
      idempotencyKey: key,
      requestFingerprint: key === undefined ? undefined : requestFingerprint,
      receiptPlanBalance,
      planAmount,
      frozenRate,
    };

    const payment = await this.repo.create(repoInput);
    return { ...payment, duplicateReferenceOf: payMethod.duplicateReferenceOf };
  }

  /**
   * El importe (> 0) y la moneda (de la lista blanca, en mayúsculas) de un
   * abono: 400 si no valen.
   */
  async validCurrency(input: {
    amount: number;
    currency: string;
  }): Promise<string> {
    if (!isFinitePositive(input.amount)) {
      throw new BadRequestException('amount must be a finite number > 0');
    }
    if (!input.currency || input.currency.trim() === '') {
      throw new BadRequestException('currency is required');
    }
    const currency = input.currency.trim().toUpperCase();
    if (!(await this.whitelist.has(currency))) {
      throw new BadRequestException(`Unknown currency: ${currency}`);
    }
    return currency;
  }

  /**
   * Lo que un abono a un plan resuelve FUERA de su transacción (DX-390: el
   * abono suelto y cada línea de un cobro dividido, con las mismas reglas):
   * el medio, la referencia y el aviso de repetida (DX-377), el día civil en
   * la sede, la tasa que congela (DX-375) y su importe en la moneda del plan
   * (la base, DX-051), o `null` sin tasa.
   */
  async prepareLine(
    plan: { currency: string },
    input: PaymentMethodRequest & { amount: number },
    currency: string,
    paidAt: Date | CivilPaidDay,
  ): Promise<PreparedPaymentLine> {
    const method = await this.paymentMethodGate.resolve(input, paidAt);

    // DX-375, DX-136 y DX-051 (R4): fuera de la transacción del abono (la
    // tasa puede pedir un proveedor externo), UNA cotización con la fuente de
    // la clínica y el día civil del abono en su sede: es la tasa que el abono
    // congela, y con ella salen el saldo del recibo y la base. Nunca falla:
    // sin tasa (o con cualquier fallo) el abono se guarda «sin tasa», el
    // recibo sin saldo y sin base, y el barrido la congela cuando la haya.
    const paidOn = await this.repo.resolvePaidOn(paidAt);
    const frozenRate = await this.freeze({
      currency,
      targetCurrency: plan.currency,
      paidOn,
    });
    const converted = await paymentBaseAmount(
      this.convertAmount,
      {
        amount: input.amount,
        currency,
        paidOn,
        exchangeRateCurrency: plan.currency,
        frozenRate,
      },
      plan.currency,
    );
    return { method, paidOn, frozenRate, converted };
  }

  /** La tasa que congela el abono (DX-375), o `null` sin tasa o si algo falla. */
  private async freeze(payment: {
    currency: string;
    targetCurrency: string;
    paidOn: string;
  }): Promise<FrozenExchangeRate | null> {
    try {
      return await freezePaymentRate(this.convertAmount, payment);
    } catch (error) {
      this.logger.warn({
        event: 'payments.exchange_rate_unavailable',
        error: errorName(error),
      });
      return null;
    }
  }
}
