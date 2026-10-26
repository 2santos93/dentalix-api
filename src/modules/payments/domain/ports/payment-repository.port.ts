import type { IdempotentPayment } from '../idempotency';
import { ClinicRole, PaymentMethod } from '@prisma/client';
import { Payment } from '../entities/payment.entity';
import { CashPayment } from '../entities/cash-payment.entity';
import type { VoidSubject } from '../void-window';
import type { ReceiptPlanBalance } from '../receipt-snapshot';

// NOTE: deliberately NO `tenantId`/`id` field — the tenant comes from the
// guarded request context (never the client), same convention as
// CreateSaleRepoInput/AddTreatmentPlanItemRepoInput. `patientId` IS required
// here (unlike CreateSaleRepoInput's optional one): it is ALWAYS derived
// from the treatment plan by `RecordPaymentUseCase` before the repo is
// called, never accepted from the caller directly.
/**
 * Un pago del que solo se conoce el DÍA civil (YYYY-MM-DD): el repositorio lo
 * guarda al mediodía de la zona de la sede del abono (DX-097), que solo él
 * conoce (la sede sale del request o es la principal).
 */
export interface CivilPaidDay {
  civilDate: string;
}

export interface CreatePaymentRepoInput {
  /** Exactamente uno de los dos (payments_target_check, DX-262). */
  treatmentPlanId: string | null;
  /** Abono contra un saldo migrado del paciente (DX-262); sin él, a un plan. */
  openingBalanceId?: string | null;
  patientId: string;
  amount: number;
  currency: string;
  /** Instante del pago, o solo su día civil. */
  paidAt: Date | CivilPaidDay;
  method?: PaymentMethod;
  notes?: string;
  createdById?: string;
  /**
   * Idempotency-Key (UUID) for dedup. When set, persisted and covered by the
   * partial unique index (tenantId, idempotencyKey). `undefined` → stored as
   * NULL (unconstrained). Validated/normalized by RecordPaymentUseCase before
   * it reaches here (never taken raw from the client).
   */
  idempotencyKey?: string;
  /**
   * Huella de la petición (`paymentRequestFingerprint`, DX-109). Se guarda con
   * la clave; si dos peticiones con la misma clave se cruzan, el repositorio
   * solo devuelve el original cuando la huella coincide (si no, 422).
   */
  requestFingerprint?: string;
  /**
   * Saldo del plan tras este abono (DX-136), en la moneda del plan, para la
   * foto del recibo que se emite en la MISMA transacción. `null` si no se
   * pudo calcular (p. ej. sin tasa de cambio): el recibo se emite igual.
   */
  receiptPlanBalance: ReceiptPlanBalance | null;
  /**
   * DX-051 (R4): el abono convertido a la moneda del plan con la tasa de su
   * `paidOn`, calculado FUERA de la transacción. Si la moneda que lee el
   * INSERT con el plan bloqueado sigue siendo `planCurrency`, nace su base y
   * el plan queda encolado para el reparto. `null`: sin base (sin tasa, un
   * fallo de la conversión o un abono a un saldo migrado).
   */
  planAmount: { planCurrency: string; amount: number; rateDate: string } | null;
}

/** Un saldo migrado vivo (DX-262) con lo que el abono necesita validar. */
export interface OpeningBalanceTarget {
  id: string;
  patientId: string;
  currency: string;
  amount: number;
  /** Abonado vivo en su moneda. */
  paid: number;
}

/**
 * Un período de días CIVILES (YYYY-MM-DD, ambos inclusive, ya validados). El
 * repositorio lo traduce a instantes con la zona de CADA sede (DX-097): con
 * varias sedes en zonas distintas, cada una corta su día a su medianoche.
 */
export interface CivilPeriod {
  /** Primer día, inclusive. */
  from: string;
  /** Último día, inclusive. */
  to: string;
}

export type ListPaymentsReceivedInRangeParams = CivilPeriod;

/** Abono del período (ya trae `paidOn`, su día civil en la zona de su sede). */
export type ReceivedPayment = Payment;

export interface ListCashRegisterParams extends CivilPeriod {
  method?: PaymentMethod;
  /** Ya normalizado por el caso de uso. */
  skip: number;
  /** Ya acotado por el caso de uso. */
  take: number;
}

/**
 * Suma de un grupo (moneda, método) con los mismos filtros que la página.
 * `total` es la suma exacta de SQL sobre `Decimal(14,2)` pasada a `number`.
 */
export interface CashRegisterGroup {
  currency: string;
  method: PaymentMethod | null;
  total: number;
  count: number;
}

/** Una fila de la caja con lo que decide si el actor puede anularla. */
export interface CashRegisterRow {
  payment: CashPayment;
  voidSubject: VoidSubject;
}

export interface CashRegisterPage {
  items: CashRegisterRow[];
  /** Filas que casan con los filtros (no solo las de esta página). */
  total: number;
  /** Agregado por (moneda, método) del período entero, sin paginar. */
  groups: CashRegisterGroup[];
  /** La sede activa del request, o `null` en la vista consolidada. */
  scopeLocation: { id: string; name: string } | null;
}

/**
 * Lo que la regla de anulación necesita saber del abono ANTES de anularlo:
 * quién lo registró, cuándo, y la zona horaria de su sede (para decidir qué
 * es "hoy" — ver `voidDenial`).
 */
export interface PaymentVoidTarget extends VoidSubject {
  id: string;
}

/** Desde dónde se anula: para el `audit_event` de la reapertura (DX-215). */
export interface PaymentVoidRequest {
  locationId: string | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
}

/** Rastro de la anulación (SEC-013). */
export interface PaymentVoidAudit {
  voidedById: string;
  /** Rol de quien anula (DX-215: actor del evento de la reapertura). */
  voidedByRole: ClinicRole;
  voidedAt: Date;
  reason: string;
  /** `null` fuera de una petición HTTP. */
  request: PaymentVoidRequest | null;
}

export const PAYMENT_REPOSITORY = Symbol('PAYMENT_REPOSITORY');

export interface PaymentRepository {
  /**
   * Inserta el abono. Dentro de la MISMA transacción vuelve a comprobar que el
   * plan sigue vivo y es del paciente (404 si no; DB-014). Si otra petición
   * con la misma `idempotencyKey` se le adelantó (carrera entre reintentos),
   * devuelve el abono ORIGINAL en vez de fallar.
   */
  create(input: CreatePaymentRepoInput): Promise<Payment>;

  /**
   * DX-262: el saldo migrado vivo (no retirado) de esta clínica con lo abonado
   * en su moneda, o `null` (no existe, retirado u otra clínica por RLS).
   */
  findOpeningBalance(id: string): Promise<OpeningBalanceTarget | null>;

  /** Abonos activos contra un saldo migrado (DX-262), por `paidAt` DESC. */
  listByOpeningBalance(openingBalanceId: string): Promise<Payment[]>;

  /**
   * El día civil (YYYY-MM-DD) que tendrá un abono con este `paidAt` en la sede
   * donde se va a registrar (la del request o la principal, DX-097): la fecha
   * de la tasa con que el recibo convierte el abono a la moneda del plan.
   */
  resolvePaidOn(paidAt: Date | CivilPaidDay): Promise<string>;

  /**
   * The payment, or `null` if it is absent, soft-deleted (voided), or
   * belongs to another tenant (RLS makes those indistinguishable from
   * "absent").
   */
  findById(id: string): Promise<Payment | null>;

  /**
   * The payment carrying this Idempotency-Key in the current tenant (RLS-
   * scoped), or `null` if none. Deliberately NOT filtered by `deletedAt`:
   * idempotency means "same request → same row" regardless of whether that row
   * was later voided, so a replay never creates a duplicate.
   */
  findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<IdempotentPayment | null>;

  /**
   * Active payments (`deletedAt: null`) for a plan, ordered by `paidAt` DESC.
   * NO limit on purpose (DX-043, DB-018): GetPlanBalanceUseCase sums this
   * list, and a truncated list would report a wrong balance.
   */
  listByPlan(treatmentPlanId: string): Promise<Payment[]>;

  /** Active payments (`deletedAt: null`) for a patient, ordered by `paidAt` DESC. */
  listByPatient(patientId: string): Promise<Payment[]>;

  /**
   * El abono ACTIVO (no anulado) con lo que decide si el actor puede anularlo,
   * o `null` si no existe, ya está anulado o es de otro tenant (RLS).
   */
  findVoidTarget(id: string): Promise<PaymentVoidTarget | null>;

  /**
   * Soft-delete (void): atomically sets `deletedAt` + the void audit
   * (`voidedById`, `voidedAt`, `voidReason`) ONLY if the row is currently
   * active (`deletedAt: null`) -- a single check-and-set, not a separate find
   * then update, so two concurrent voids of the same payment can't both "win"
   * (TOCTOU race). Returns `true` if this call actually voided the payment,
   * `false` if it was already voided or doesn't exist (never throws for that
   * case -- the use case decides 404). Never a hard delete.
   *
   * DX-215: in the SAME transaction, re-evaluates every KEPT payment promise
   * of the patient in the payment's currency that this payment counted for
   * (back to OPEN, or BROKEN after its day), audited with `audit`'s actor and
   * request.
   */
  softDelete(id: string, audit: PaymentVoidAudit): Promise<boolean>;

  /**
   * Abonos activos (de la sede activa, o de todas) cuyo `paidAt` cae en los
   * días civiles `from`..`to` (ambos inclusive) EN LA ZONA DE SU SEDE, con ese
   * día civil (`paidOn`) — lo que `GetPaymentsTotalsUseCase` necesita para la
   * métrica de ingresos del dashboard.
   */
  listReceivedInRange(
    params: ListPaymentsReceivedInRangeParams,
  ): Promise<ReceivedPayment[]>;

  /**
   * La CAJA: una página de abonos activos del período (de la sede activa, o
   * de toda la clínica sin sede), con paciente/plan/sede resueltos en la misma
   * consulta, más el agregado por (moneda, método) del período entero. Página,
   * conteo y agregado van en UNA transacción REPEATABLE READ (misma foto para
   * todas las sentencias): los totales describen siempre el mismo universo que
   * las filas, aunque se registre un abono a la vez. Orden `paidAt` DESC,
   * `id` DESC.
   */
  listForCashRegister(
    params: ListCashRegisterParams,
  ): Promise<CashRegisterPage>;
}
