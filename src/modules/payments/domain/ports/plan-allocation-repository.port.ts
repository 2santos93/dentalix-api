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

  /** Clínicas vivas, para el barrido (sin tenant: tabla sin RLS). */
  tenantIds(): Promise<string[]>;
}
