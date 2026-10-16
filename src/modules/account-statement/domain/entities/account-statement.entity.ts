import {
  DocType,
  PaymentMethod,
  PaymentPlanStatus,
  TreatmentPlanStatus,
} from '@prisma/client';
import { InstallmentStatus } from '../../../payment-plans/application/schedule/derive-statuses';

/*
 * Estado de cuenta del paciente (DX-011): la foto financiera consolidada de UN
 * paciente — lo presupuestado en sus planes, lo abonado, el saldo y las cuotas.
 *
 * Deliberadamente SIN datos clínicos: ni ítems del plan (diente, procedimiento),
 * ni notas de planes o abonos, ni nada de la historia. Un estado de cuenta se
 * imprime y se entrega en mano; lo que no hace falta para cobrar no viaja.
 */

// ---------------------------------------------------------------------------
// Entrada del cálculo: lo que el repositorio lee, ya en `number`.
// ---------------------------------------------------------------------------

export interface StatementPlanRow {
  id: string;
  status: TreatmentPlanStatus;
  currency: string;
  createdAt: Date;
  /** Σ precio de los ítems vivos ACCEPTED|DONE (lo facturable del plan). */
  billable: number;
}

export interface StatementPaymentRow {
  id: string;
  treatmentPlanId: string;
  amount: number;
  currency: string;
  paidAt: Date;
  method: PaymentMethod | null;
  location: { id: string; name: string };
  /** Quién registró el abono (`null` en abonos antiguos sin autor). */
  createdById: string | null;
  /** Cuándo se registró: con `timeZone`, decide el "hoy" de la anulación. */
  createdAt: Date;
  /** IANA de la sede del abono (su horario), o la zona por defecto. */
  timeZone: string;
  /** `deletedAt` del abono: no nulo = anulado. */
  voidedAt: Date | null;
  /** Quién lo anuló (SEC-013); `null` si está activo o se anuló sin rastro. */
  voidedBy: StatementVoidedBy | null;
  /** Motivo de la anulación; `null` si está activo o es una anulación antigua. */
  voidReason: string | null;
}

/**
 * Autor de una anulación. `fullName` es `null` si el usuario ya no es (ni fue)
 * miembro de esta clínica — p. ej. el superadmin de plataforma entrando como
 * ADMIN —: su nombre no se lee fuera de la membresía.
 */
export interface StatementVoidedBy {
  id: string;
  fullName: string | null;
}

export interface StatementPaymentPlanRow {
  id: string;
  treatmentPlanId: string;
  currency: string;
  status: PaymentPlanStatus;
  downPayment: number;
  startDate: Date;
  installments: { sequence: number; dueDate: Date; amount: number }[];
}

export interface StatementSnapshot {
  plans: StatementPlanRow[];
  /** TODOS los abonos del paciente, anulados incluidos. */
  payments: StatementPaymentRow[];
  /** Planes de pago vivos (no cancelados) del paciente. */
  paymentPlans: StatementPaymentPlanRow[];
}

// ---------------------------------------------------------------------------
// Salida del cálculo.
// ---------------------------------------------------------------------------

export interface StatementNextInstallment {
  treatmentPlanId: string;
  /** `null` para la cuota inicial. */
  sequence: number | null;
  dueDate: Date;
  /** Lo que falta por cubrir de esa cuota. */
  amount: number;
}

export interface StatementCurrencySummary {
  currency: string;
  budgeted: number;
  paid: number;
  balance: number;
  overdueCount: number;
  overdueAmount: number;
  nextInstallment: StatementNextInstallment | null;
}

export interface StatementPlanLine {
  id: string;
  status: TreatmentPlanStatus;
  currency: string;
  createdAt: Date;
  /** Facturable del plan (ítems ACCEPTED|DONE), aunque esté cancelado. */
  budgeted: number;
  /** `false` para un plan CANCELLED: su facturable no suma al saldo. */
  countsTowardsBalance: boolean;
  /** Abonos vivos del plan en SU moneda. */
  paid: number;
  /** Abonos vivos del plan hechos en otra moneda (no se convierten). */
  paidOtherCurrencies: { currency: string; amount: number }[];
  /** `(countsTowardsBalance ? budgeted : 0) - paid`. */
  balance: number;
}

export interface StatementMovement {
  id: string;
  paidAt: Date;
  amount: number;
  currency: string;
  method: PaymentMethod | null;
  location: { id: string; name: string };
  treatmentPlanId: string;
  /** Quién registró el abono (`null` en abonos antiguos sin autor). */
  createdById: string | null;
  /**
   * Si quien consulta puede anular el abono (DX-057): misma regla que
   * `DELETE /payments/:id` (`voidDenial`); siempre `false` si ya está anulado.
   */
  canVoid: boolean;
  voided: boolean;
  voidedAt: Date | null;
  voidedBy: StatementVoidedBy | null;
  voidReason: string | null;
}

export type StatementInstallmentKind = 'DOWN_PAYMENT' | 'INSTALLMENT';

export interface StatementInstallment {
  paymentPlanId: string;
  treatmentPlanId: string;
  currency: string;
  kind: StatementInstallmentKind;
  sequence: number | null;
  dueDate: Date;
  amount: number;
  covered: number;
  outstanding: number;
  status: InstallmentStatus;
}

export interface ComputedAccountStatement {
  summary: StatementCurrencySummary[];
  plans: StatementPlanLine[];
  movements: StatementMovement[];
  installments: StatementInstallment[];
}

// ---------------------------------------------------------------------------
// Respuesta completa del endpoint.
// ---------------------------------------------------------------------------

export interface StatementPatient {
  id: string;
  firstName: string;
  lastName: string;
  docType: DocType;
  docNumber: string | null;
}

export interface StatementClinic {
  name: string;
  logoUrl: string | null;
}

export interface AccountStatement extends ComputedAccountStatement {
  issuedAt: Date;
  clinic: StatementClinic;
  patient: StatementPatient;
  /** Filtro aplicado a `movements` (días civiles inclusive), o `null`. */
  range: { from: string | null; to: string | null };
}
