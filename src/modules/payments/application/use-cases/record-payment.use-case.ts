import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AcceptedCurrenciesGate } from '../../../exchange/application/accepted-currencies-gate';
import { PaymentMethod } from '@prisma/client';
import type { LockActor } from '../../../financial-lock/domain/financial-lock';
import { IDEMPOTENCY_KEY_INVALID_MESSAGE } from '../../../../shared/validation/idempotency-key';
import { PAYMENT_REPOSITORY } from '../../domain/ports/payment-repository.port';
import { PAYMENT_CLOCK, type PaymentClock } from './void-payment.use-case';
import {
  PAID_AT_AFTER_SITE_TODAY_MESSAGE,
  PAID_AT_IN_FUTURE_MESSAGE,
  isPaidAtAfterSiteToday,
  isPaidAtTooFarInFuture,
} from '../../domain/paid-at-window';
import type {
  CivilPaidDay,
  CreatePaymentRepoInput,
  PaymentInsertHook,
  PaymentRepository,
} from '../../domain/ports/payment-repository.port';
import type { PaymentProofAttachment } from '../../domain/payment-proof';
import { BASE_CURRENCY } from '../../../exchange/domain/exchange-rate-source';
import { parseCivilDate } from '../../../../shared/time/civil-day';
import { Payment } from '../../domain/entities/payment.entity';
import {
  IDEMPOTENCY_KEY_REUSED_MESSAGE,
  isSameRequest,
  paymentRequestFingerprint,
  paymentRequestFingerprints,
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
import { PaymentProofs, attachmentOf } from '../payment-proofs';
import {
  PaymentMethodGate,
  type PaymentMethodRequest,
  type ResolvedPaymentMethod,
} from '../payment-method-gate';
import {
  CURRENCY_REQUIRED_MESSAGE,
  PAYMENT_AMOUNT_MESSAGE,
  UNKNOWN_CURRENCY_MESSAGE,
} from '../../../../shared/money/currency-messages';
import {
  CashChangePreparer,
  hasCashChange,
  type CashChangeRequest,
} from '../cash-change-preparer';
import type { PaymentCashChange } from '../../domain/cash-change';
import { collectedAmount } from '../../../payment-methods/domain/payment-adjustments';

// NOTE: deliberately NO `patientId`/`treatmentPlanId` field on the input
// object itself (`treatmentPlanId` is a separate `execute()` argument,
// `patientId` is ALWAYS derived from the plan) — same convention as
// CreateSaleInput never accepting `total`/`amount` from the caller.
export interface RecordPaymentInput extends CashChangeRequest {
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
  /** DX-389: subida del comprobante (`POST /payments/proofs/upload-url`). */
  proofUploadId?: string;
  notes?: string;
}

/**
 * DX-569: lo que añade quien registra el abono por otra vía que el
 * formulario de caja (confirmar el reporte del paciente).
 */
export interface RecordPaymentOptions {
  /**
   * El comprobante ya comprobado y copiado a su clave definitiva (el del
   * reporte): pasa tal cual a `PaymentProof`, sin `proofs.complete` ni
   * limpieza (su objeto lo sigue referenciando el reporte). `proofUploadId`
   * del input tiene que ser el suyo (la política del medio lo mira).
   */
  proof?: PaymentProofAttachment | null;
  /**
   * La tasa que fija recepción con motivo, en unidades de la moneda que no
   * es la base por 1 USD (una de las dos monedas tiene que ser USD): se
   * congela en vez de la cotizada con la fuente de la clínica.
   */
  rateOverride?: number;
  /** Ver `PaymentInsertHook`. */
  afterInsertInTx?: PaymentInsertHook;
  /**
   * DX-091: quién registra y su motivo para hacerlo en un período contable
   * cerrado (ver `CreatePaymentRepoInput.lockActor`). No entra en la huella
   * de idempotencia, como el motivo de una referencia repetida.
   */
  lockActor?: LockActor | null;
  /**
   * DX-584: no mirar las monedas que acepta la clínica. Solo la confirmación
   * de un pago reportado por el enlace (DX-569): su moneda la fijó el enlace
   * al crearlo y el paciente ya pagó; rechazarlo al confirmar no tiene arreglo.
   */
  anyCurrency?: boolean;
}

export const RATE_OVERRIDE_PAIR_MESSAGE =
  'Solo se puede indicar la tasa cuando una de las dos monedas es la base (USD) y la otra no.';
export const RATE_OVERRIDE_NOT_NEEDED_MESSAGE =
  'El abono va en la moneda de lo que se cobra: no hace falta tasa.';

/**
 * DX-569: la tasa que fija recepción como tasa congelada (fuente MANUAL, del
 * día del abono). `perBase` son unidades de la moneda que no es USD por
 * 1 USD; 400 si ninguna de las dos es USD o si las dos son la misma.
 */
export function overrideFrozenRate(
  paymentCurrency: string,
  targetCurrency: string,
  perBase: number,
  paidOn: string,
): FrozenExchangeRate {
  if (paymentCurrency === targetCurrency) {
    throw new BadRequestException(RATE_OVERRIDE_NOT_NEEDED_MESSAGE);
  }
  if (paymentCurrency !== BASE_CURRENCY && targetCurrency !== BASE_CURRENCY) {
    throw new BadRequestException(RATE_OVERRIDE_PAIR_MESSAGE);
  }
  // Con hasta 8 decimales (lo valida el DTO): cabe en Decimal(18,8).
  const rate = perBase;
  return {
    currency: targetCurrency,
    fromPerBase: paymentCurrency === BASE_CURRENCY ? 1 : rate,
    toPerBase: targetCurrency === BASE_CURRENCY ? 1 : rate,
    source: 'MANUAL',
    date: paidOn,
    quotedOn: paidOn,
  };
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
 * La ventana de fecha de un abono, una sola vez para los tres caminos (suelto,
 * repartido y saldo inicial): ni un día civil (DX-075) ni un instante (DX-110,
 * por su día civil en la zona de la sede) pueden caer después de hoy en la
 * sede (se mira primero, así que mañana, o dentro de 3 días, da el mismo
 * mensaje); y, si la sede no tiene zona, rige la ventana de 24 h por delante
 * del reloj (DX-054), que además queda como piso común.
 */
export async function assertPaidAtWindow(
  repo: Pick<PaymentRepository, 'siteToday'>,
  paidAt: Date | CivilPaidDay,
  now: Date,
): Promise<void> {
  if (isPaidAtAfterSiteToday(paidAt, await repo.siteToday(now))) {
    throw new BadRequestException(PAID_AT_AFTER_SITE_TODAY_MESSAGE);
  }
  if (isPaidAtTooFarInFuture(paidAt, now)) {
    throw new BadRequestException(PAID_AT_IN_FUTURE_MESSAGE);
  }
}

/**
 * DX-097: `YYYY-MM-DD` es un día civil (el formulario de abono), y también una
 * medianoche UTC exacta (clientes antiguos, ver `isUtcMidnight`); cualquier
 * otra fecha ISO con hora es un instante y debe traer `Z` o desfase. Sin esta
 * distinción, `new Date` leería el día como medianoche UTC, que en una sede
 * al oeste de UTC es la tarde del día ANTERIOR.
 */
export function normalizePaidAt(value: string | Date): Date | CivilPaidDay {
  if (typeof value === 'string' && CIVIL_DATE_SHAPE.test(value)) {
    const civilDate = parseCivilDate(value);
    if (civilDate === null) {
      throw new BadRequestException('La fecha del abono no es válida.');
    }
    return { civilDate };
  }
  if (typeof value === 'string' && !EXPLICIT_OFFSET.test(value.trim())) {
    throw new BadRequestException(
      'La fecha y hora del abono debe indicar la zona horaria (Z o un desfase UTC).',
    );
  }
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new BadRequestException('La fecha del abono no es válida.');
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
    // DX-389: el comprobante del cobro (subida directa ya hecha).
    private readonly proofs: PaymentProofs,
    // DX-054: la fecha del abono no puede ir más de 24 h por delante.
    @Inject(PAYMENT_CLOCK)
    private readonly now: PaymentClock,
    // DX-570: lo recibido y el vuelto de un abono en efectivo.
    private readonly cashChange: CashChangePreparer,
    // DX-584: solo las monedas que acepta la clínica (lista vacía = todas).
    @Optional()
    private readonly acceptedCurrencies?: AcceptedCurrenciesGate,
  ) {}

  /**
   * DX-584: 400 `CURRENCY_NOT_ACCEPTED` si la clínica tiene monedas aceptadas
   * y alguna de estas (ya normalizadas) no está. La usan el abono suelto y
   * el cobro dividido (todas sus líneas de una vez).
   */
  async assertAcceptedCurrencies(currencies: readonly string[]): Promise<void> {
    await this.acceptedCurrencies?.assertAccepted(currencies);
  }

  /**
   * `normalizePaidAt` más la ventana de fecha: DX-054 (400 si va a más de 24 h
   * en el futuro) y DX-075 (400 si es un día civil posterior a hoy en la
   * sede). La usan el abono suelto y el repartido.
   */
  async checkedPaidAt(value: string | Date): Promise<Date | CivilPaidDay> {
    const paidAt = normalizePaidAt(value);
    await assertPaidAtWindow(this.repo, paidAt, this.now());
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
    options: RecordPaymentOptions = {},
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
        throw new BadRequestException(IDEMPOTENCY_KEY_INVALID_MESSAGE);
      }
      const existing = await this.repo.findByIdempotencyKey(key);
      if (existing) {
        // DX-109 (BE-017): solo la MISMA petición recibe el abono original;
        // otro plan u otro cuerpo con la misma clave es un error del cliente.
        if (
          !isSameRequest(
            existing,
            treatmentPlanId,
            paymentRequestFingerprints(treatmentPlanId, input),
          )
        ) {
          throw new UnprocessableEntityException(
            IDEMPOTENCY_KEY_REUSED_MESSAGE,
          );
        }
        return existing.payment;
      }
    }

    const currency = await this.validCurrency(input);
    if (options.anyCurrency !== true) {
      await this.assertAcceptedCurrencies([currency]);
    }
    // DX-570: la forma del vuelto, antes de tocar nada.
    const withChange = hasCashChange(input);
    if (withChange) this.cashChange.assertShape(input);
    const paidAt = await this.checkedPaidAt(input.paidAt);

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
      converted: convertedAsTyped,
    } = await this.prepareLine(
      plan,
      input,
      currency,
      paidAt,
      options.rateOverride,
    );
    // DX-570: el vuelto (medio, moneda, tasa del día y cuadre). Un resto
    // confirmado se suma al importe del abono, y con él su base.
    let amount = input.amount;
    let converted = convertedAsTyped;
    let cashChange: PaymentCashChange | null = null;
    if (withChange) {
      const prepared = await this.cashChange.prepare(input, {
        amount: input.amount,
        currency,
        method: payMethod.method,
        collected: collectedAmount(input.amount, payMethod.adjustments),
        hasAdjustments: payMethod.adjustments.length > 0,
        paidOn,
      });
      cashChange = prepared.change;
      if (prepared.amount !== input.amount) {
        amount = prepared.amount;
        converted = await paymentBaseAmount(
          this.convertAmount,
          {
            amount,
            currency,
            paidOn,
            exchangeRateCurrency: plan.currency,
            frozenRate,
          },
          plan.currency,
        );
      }
    }
    const receiptPlanBalance = await this.receiptBalance.afterPayment(
      treatmentPlanId,
      converted,
    );
    const planAmount =
      converted === null
        ? null
        : { planCurrency: plan.currency, amount: converted, rateDate: paidOn };

    // DX-389: lo último antes de la transacción (copia el objeto subido).
    // DX-569: el del reporte ya está copiado y comprobado.
    const proof =
      options.proof === undefined
        ? await this.proofs.complete(payMethod.proofUploadId, createdById)
        : null;
    const repoInput: CreatePaymentRepoInput = {
      treatmentPlanId,
      openingBalanceId: null,
      patientId: plan.patientId,
      amount,
      currency,
      paidAt,
      method: payMethod.method,
      paymentMethodId: payMethod.paymentMethodId,
      reference: payMethod.reference,
      referenceNormalized: payMethod.referenceNormalized,
      duplicateReferenceReason: payMethod.duplicateReferenceReason,
      adjustments: payMethod.adjustments,
      proof: options.proof === undefined ? attachmentOf(proof) : options.proof,
      notes: input.notes,
      createdById,
      idempotencyKey: key,
      requestFingerprint: key === undefined ? undefined : requestFingerprint,
      receiptPlanBalance,
      receiptBalanceInTx: this.receiptBalance.inTransaction,
      planAmount,
      frozenRate,
      frozenRateOverride: options.rateOverride !== undefined,
      afterInsertInTx: options.afterInsertInTx,
      lockActor: options.lockActor ?? null,
      cashChange,
    };

    let payment: Payment;
    try {
      payment = await this.repo.create(repoInput);
    } catch (error) {
      await this.proofs.settle([proof], false);
      throw error;
    }
    await this.proofs.settle([proof], true);
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
      throw new BadRequestException(PAYMENT_AMOUNT_MESSAGE);
    }
    if (!input.currency || input.currency.trim() === '') {
      throw new BadRequestException(CURRENCY_REQUIRED_MESSAGE);
    }
    const currency = input.currency.trim().toUpperCase();
    if (!(await this.whitelist.has(currency))) {
      throw new BadRequestException(UNKNOWN_CURRENCY_MESSAGE);
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
    /** DX-569: ver `RecordPaymentOptions.rateOverride`. */
    rateOverride?: number,
  ): Promise<PreparedPaymentLine> {
    // DX-516: con los ajustes del medio sobre el importe de ESTA línea.
    const method = await this.paymentMethodGate.resolve(input, paidAt, {
      amount: input.amount,
      currency,
    });

    // DX-375, DX-136 y DX-051 (R4): fuera de la transacción del abono (la
    // tasa puede pedir un proveedor externo), UNA cotización con la fuente de
    // la clínica y el día civil del abono en su sede: es la tasa que el abono
    // congela, y con ella salen el saldo del recibo y la base. Nunca falla:
    // sin tasa (o con cualquier fallo) el abono se guarda «sin tasa», el
    // recibo sin saldo y sin base, y el barrido la congela cuando la haya.
    const paidOn = await this.repo.resolvePaidOn(paidAt);
    const frozenRate =
      rateOverride === undefined
        ? await this.freeze({
            currency,
            targetCurrency: plan.currency,
            paidOn,
          })
        : overrideFrozenRate(currency, plan.currency, rateOverride, paidOn);
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
