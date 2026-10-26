import type {
  Prisma,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
} from '@prisma/client';
import type {
  AllocatableItem,
  AllocationIncrement,
  Donor,
} from '../allocation-rules';

/**
 * Lo que el reparto de un plan ve con sus filas bloqueadas (spec R6): los
 * donantes (abonos vivos NO fijados, con base en la moneda del plan) y los
 * ítems facturables, cada uno con lo que ya tiene imputado.
 */
export interface PlanAllocationSnapshot {
  donors: Donor[];
  items: AllocatableItem[];
}

export interface RebalanceOptions {
  /** Autor de las filas AUTO; `null` en el barrido y el backfill. */
  actorId: string | null;
  /** Calcula y escribe, y deshace la transacción al final (R17 `--dry-run`). */
  dryRun?: boolean;
  /**
   * Drenado: si no queda ninguna solicitud del plan sin reclamar (otro
   * drenador ya las tiene), no reparte; ese drenador lo hará.
   */
  onlyIfRequested?: boolean;
}

/** Un abono vivo a un plan vivo que todavía no tiene base (R9.3, R15). */
export interface PaymentWithoutBase {
  paymentId: string;
  amount: number;
  currency: string;
  planCurrency: string;
  /** Día civil del abono en su sede: la fecha de la tasa (DX-097). */
  paidOn: string;
}

/**
 * Foto del saldo de un plan para el saldo por ítem (spec R14), leída en UNA
 * transacción `RepeatableRead`: el plan, sus ítems vivos (en orden de alta),
 * los abonos vivos y los hechos de imputación, todos de la misma foto.
 * Importes en la moneda del plan salvo `payments` (moneda del abono).
 */
export interface PlanBalanceSnapshot {
  plan: { status: TreatmentPlanStatus; currency: string };
  items: {
    id: string;
    toothNumber: string;
    /** Rótulo en español del catálogo (`labelEs`). */
    procedureName: string;
    status: TreatmentPlanItemStatus;
    price: number;
    discount: number;
  }[];
  payments: { id: string; amount: number; currency: string; paidOn: string }[];
  allocations: { paymentId: string; itemId: string; amount: number }[];
  bases: { paymentId: string; amount: number; manual: boolean }[];
}

/**
 * El abono que se va a imputar a mano (spec R10, §5.2): vivo y de esta
 * clínica. `treatmentPlanId` `null` = abono a un saldo migrado (DX-262), sin
 * plan ni base. `base` `null` = aún sin convertir (sin tasa, R15).
 */
export interface AllocationTarget {
  paymentId: string;
  receiptNumber: string | null;
  treatmentPlanId: string | null;
  /** En la moneda del abono. */
  amount: number;
  currency: string;
  /** Día civil del abono en su sede: la fecha de la tasa (DX-097). */
  paidOn: string;
  planCurrency: string | null;
  planStatus: TreatmentPlanStatus | null;
  /** En la moneda del plan. */
  base: { amount: number; manual: boolean } | null;
}

/** Ítem imputable (vivo, ACCEPTED/DONE, plan cobrable) visto desde un abono. */
export interface AllocationItemOption {
  id: string;
  toothNumber: string;
  procedureName: string;
  status: 'ACCEPTED' | 'DONE';
  billableCents: number;
  /** Lo que le imputan los OTROS abonos del plan. */
  paidByOthersCents: number;
}

/**
 * La imputación de un abono en UNA foto (`RepeatableRead`): el abono, sus
 * líneas vivas y los ítems imputables del plan en el orden del plan.
 */
export interface PaymentAllocationsSnapshot {
  target: AllocationTarget;
  lines: { itemId: string; cents: number; source: 'AUTO' | 'MANUAL' }[];
  items: AllocationItemOption[];
}

/** Reasignación de un ADMIN (R10). `lines` vacío con `AUTO`. */
export interface ReplaceAllocationsInput {
  paymentId: string;
  mode: 'MANUAL' | 'AUTO';
  expectedVersion: string;
  lines: { itemId: string; cents: number }[];
  actorId: string;
}

export const PLAN_ALLOCATION_REPOSITORY = Symbol('PLAN_ALLOCATION_REPOSITORY');

/**
 * Persistencia del reparto automático (DX-051, spec R6, R9, R12). Todo en el
 * tenant del contexto (`runWithTenant`, RLS FORCE) con `tenantId` explícito.
 */
export interface PlanAllocationRepository {
  /**
   * El reparto de un plan en UNA transacción (R9.1): reclama las solicitudes
   * del plan (`FOR UPDATE SKIP LOCKED`), bloquea en el orden de R6 (plan FOR
   * SHARE → bases no fijadas por `paymentId` → ítems facturables por `id`),
   * lee la foto en sentencias POSTERIORES, escribe AUTO los incrementos que
   * devuelve `decide` y borra solo las solicitudes que reclamó. Con el plan
   * retirado o inexistente borra sus solicitudes y no reparte. Devuelve los
   * céntimos imputados.
   */
  rebalance(
    planId: string,
    options: RebalanceOptions,
    decide: (snapshot: PlanAllocationSnapshot) => AllocationIncrement[],
  ): Promise<number>;

  /**
   * Planes con solicitudes pendientes: `preferPlanId` primero (si tiene), luego
   * por la solicitud más antigua. Sin `limit`, todos.
   */
  pendingPlanIds(preferPlanId?: string, limit?: number): Promise<string[]>;

  /** El plan del abono (anulado o no), o `null` si no es a un plan o no existe. */
  planOfPayment(paymentId: string): Promise<string | null>;

  /** Hasta `limit` abonos vivos a planes vivos sin base, los más recientes primero. */
  paymentsWithoutBase(limit: number): Promise<PaymentWithoutBase[]>;

  /**
   * Inserta la base del abono si falta (con la moneda del plan aún igual a
   * `currency`) y encola su plan en la misma transacción. `true` si la creó.
   */
  ensureBase(
    paymentId: string,
    amount: number,
    currency: string,
    rateDate: string,
  ): Promise<boolean>;

  /** Encola el plan (INSERT simple, spec §3.3) en la transacción `tx`. */
  enqueuePlan(
    tx: Prisma.TransactionClient,
    tenantId: string,
    planId: string,
  ): Promise<void>;

  /** La foto del plan, o `null` si no existe, está retirado o es de otra clínica. */
  readPlanBalanceSnapshot(planId: string): Promise<PlanBalanceSnapshot | null>;

  /**
   * El abono vivo de esta clínica con su plan y su base, o `null` si no
   * existe, está anulado, es de otra clínica o su plan está retirado.
   */
  findAllocationTarget(paymentId: string): Promise<AllocationTarget | null>;

  /** La imputación del abono en una foto, o `null` como `findAllocationTarget`. */
  readPaymentAllocations(
    paymentId: string,
  ): Promise<PaymentAllocationsSnapshot | null>;

  /**
   * Reasignación de un ADMIN (R10) en UNA transacción: plan FOR SHARE → base
   * de este abono FOR UPDATE → ítems de las líneas viejas Y nuevas FOR UPDATE
   * ORDER BY id (todo cambio de una imputación toma su ítem FOR KEY SHARE por
   * la FK del historial) → relectura → versión (R11) → validación de las
   * líneas → `manual` → DELETE/INSERT con causa MANUAL → encola el plan.
   * Lanza los errores de §5.3. Devuelve las líneas de antes.
   */
  replaceAllocations(
    input: ReplaceAllocationsInput,
  ): Promise<{ previous: { itemId: string; cents: number }[] }>;

  /** Clínicas vivas, para el barrido (sin tenant: tabla sin RLS). */
  tenantIds(): Promise<string[]>;
}
