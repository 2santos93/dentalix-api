import { PaymentMethod } from '@prisma/client';
import { Payment } from '../entities/payment.entity';
import { CashPayment } from '../entities/cash-payment.entity';
import type { VoidSubject } from '../void-window';

// NOTE: deliberately NO `tenantId`/`id` field — the tenant comes from the
// guarded request context (never the client), same convention as
// CreateSaleRepoInput/AddTreatmentPlanItemRepoInput. `patientId` IS required
// here (unlike CreateSaleRepoInput's optional one): it is ALWAYS derived
// from the treatment plan by `RecordPaymentUseCase` before the repo is
// called, never accepted from the caller directly.
export interface CreatePaymentRepoInput {
  treatmentPlanId: string;
  patientId: string;
  amount: number;
  currency: string;
  paidAt: Date;
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
}

export interface ListPaymentsReceivedInRangeParams {
  from: Date;
  to: Date;
}

export interface ListCashRegisterParams {
  /** Inicio del rango, inclusive (medianoche UTC del primer día). */
  from: Date;
  /** Fin del rango, EXCLUSIVO (medianoche UTC del día siguiente al último). */
  toExclusive: Date;
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

/** Rastro de la anulación (SEC-013). */
export interface PaymentVoidAudit {
  voidedById: string;
  voidedAt: Date;
  reason: string;
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
  findByIdempotencyKey(idempotencyKey: string): Promise<Payment | null>;

  /** Active payments (`deletedAt: null`) for a plan, ordered by `paidAt` DESC. */
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
   */
  softDelete(id: string, audit: PaymentVoidAudit): Promise<boolean>;

  /**
   * Active payments (any plan/patient) whose `paidAt` falls within
   * `[from, to)` — the projection `GetPaymentsTotalsUseCase` needs for the
   * dashboard "incomes of the period" metric (mirrors
   * `SaleRepository.listForTotals`).
   */
  listReceivedInRange(
    params: ListPaymentsReceivedInRangeParams,
  ): Promise<Payment[]>;

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
