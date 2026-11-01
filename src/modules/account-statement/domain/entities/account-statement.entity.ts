import {
  DocumentType,
  PaymentMethod,
  PaymentPlanStatus,
  ResponsibleRelationship,
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
  /** Plan del abono; `null` si es contra un saldo migrado (DX-262). */
  treatmentPlanId: string | null;
  /** Saldo migrado del abono (DX-262); `null`/ausente si es a un plan. */
  openingBalanceId?: string | null;
  amount: number;
  currency: string;
  paidAt: Date;
  method: PaymentMethod | null;
  /**
   * DX-395: medio de pago de la clínica del abono (el inicial de su método si
   * lo registró una réplica anterior sin medio), o `null` si no tiene método.
   */
  paymentMethod: StatementPaymentMethodRef | null;
  /** DX-395: referencia del pago tal como se tecleó, o `null`. */
  reference: string | null;
  /** DX-515: nº de la factura fiscal externa del abono, o `null`. */
  externalInvoiceNumber?: string | null;
  /** DX-390: el cobro dividido del abono (id de su línea 1), o `null`. */
  splitId?: string | null;
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

/** Medio de pago de la clínica de un abono (DX-395): id y nombre. */
export interface StatementPaymentMethodRef {
  id: string;
  name: string;
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

/**
 * Lo que necesita el CÁLCULO del saldo de un abono (`computeBalances`): plan,
 * importe, moneda y si está anulado. Vale un abono suelto o la suma de los
 * abonos vivos de un plan en una moneda (la cartera, DX-145, lee sumas).
 */
export type BalancePaymentRow = Pick<
  StatementPaymentRow,
  'treatmentPlanId' | 'openingBalanceId' | 'amount' | 'currency' | 'voidedAt'
>;

/**
 * Saldo inicial «Saldo migrado» (DX-262): deuda que la clínica trae de su
 * programa anterior, importada con el lote de pacientes. Uno por paciente,
 * moneda y lote. Solo los vivos (no deshechos). Hoy ningún abono se imputa a
 * él (los abonos van a un plan; la imputación es DX-051): suma entero.
 */
export interface StatementOpeningBalanceRow {
  id: string;
  currency: string;
  amount: number;
  /** Día civil AAAA-MM-DD desde el que cuenta la deuda (fecha de corte). */
  asOfDate: string;
  /** La fecha es la de la importación porque el archivo no traía otra. */
  asOfDateApproximate: boolean;
  concept: string;
  importBatchId: string;
}

/** Lo que necesita el CÁLCULO de un saldo migrado (la cartera no lee más). */
export type BalanceOpeningRow = Pick<
  StatementOpeningBalanceRow,
  'id' | 'currency' | 'amount' | 'asOfDate' | 'asOfDateApproximate'
> &
  Partial<Pick<StatementOpeningBalanceRow, 'concept' | 'importBatchId'>>;

/**
 * DX-253: suma de los asientos del saldo a favor (traspasos y devoluciones)
 * de un plan en una moneda, con signo.
 */
export interface BalanceCreditRow {
  treatmentPlanId: string;
  currency: string;
  amount: number;
}

/** Entrada mínima de `computeBalances`; `StatementSnapshot` la cumple. */
export interface BalanceSnapshot {
  plans: StatementPlanRow[];
  payments: readonly BalancePaymentRow[];
  /** DX-253: asientos del saldo a favor por plan y moneda; sin ellos, ninguno. */
  creditEntries?: readonly BalanceCreditRow[];
  paymentPlans: StatementPaymentPlanRow[];
  /** Saldos migrados vivos (DX-262); sin ellos, ninguno. */
  openingBalances?: readonly BalanceOpeningRow[];
}

export interface StatementSnapshot {
  plans: StatementPlanRow[];
  /** TODOS los abonos del paciente, anulados incluidos. */
  payments: StatementPaymentRow[];
  /** Planes de pago vivos (no cancelados) del paciente. */
  paymentPlans: StatementPaymentPlanRow[];
  /** Saldos migrados vivos del paciente (DX-262). */
  openingBalances?: StatementOpeningBalanceRow[];
  /** DX-253: asientos del saldo a favor por plan y moneda. */
  creditEntries?: BalanceCreditRow[];
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
  /** Σ saldos migrados vivos de la moneda (DX-262); entra en `balance`. */
  openingBalance: number;
  /**
   * Lo que queda de esos saldos tras sus abonos (QA D5): lo que «Incluye
   * saldo migrado» del saldo. `openingBalance` sigue siendo el cargo
   * original, para que `balance = budgeted + openingBalance − paid` cuadre.
   */
  openingPending: number;
  paid: number;
  /**
   * DX-253: Σ asientos del saldo a favor de la moneda, con signo (una
   * devolución resta; un traspaso entre planes del paciente suma 0).
   * `balance = budgeted + openingBalance − paid − creditMovements`.
   */
  creditMovements: number;
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
  /** `false` para un plan CANCELLED o REJECTED: su facturable no suma al saldo. */
  countsTowardsBalance: boolean;
  /** Abonos vivos del plan en SU moneda. */
  paid: number;
  /** Abonos vivos del plan hechos en otra moneda (no se convierten). */
  paidOtherCurrencies: { currency: string; amount: number }[];
  /**
   * DX-253: Σ de los asientos del saldo a favor del plan en su moneda, con
   * signo (traspasos recibidos − traspasos dados − devoluciones). Los abonos
   * originales no cambian: esta cifra se suma a ellos.
   */
  creditMovements: number;
  /** `(countsTowardsBalance ? budgeted : 0) - paid - creditMovements`. */
  balance: number;
}

export interface StatementMovement {
  id: string;
  paidAt: Date;
  /** Día civil (YYYY-MM-DD) del pago en la zona de su sede (DX-097). */
  paidOn: string;
  amount: number;
  currency: string;
  method: PaymentMethod | null;
  /** DX-395: medio de pago de la clínica (su nombre es lo que se muestra). */
  paymentMethod: StatementPaymentMethodRef | null;
  /** DX-395: referencia del pago, o `null`. */
  reference: string | null;
  /** DX-515: nº de la factura fiscal emitida fuera de Dentalix, o `null`. */
  externalInvoiceNumber: string | null;
  /**
   * DX-390: el cobro dividido del abono (id de su línea 1) y cuántas formas de
   * pago tiene; `null` en un abono suelto. Anular una anula el cobro entero.
   */
  splitId: string | null;
  splitLines: number | null;
  location: { id: string; name: string };
  /** `null` si el abono es contra un saldo migrado (DX-262). */
  treatmentPlanId: string | null;
  /** Saldo migrado del abono (DX-262), o `null`. */
  openingBalanceId: string | null;
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

/** Línea «Saldo migrado» del estado de cuenta (DX-262). */
export type StatementOpeningBalanceLine = BalanceOpeningRow & {
  /** Abonos vivos contra este saldo, en su moneda. */
  paid: number;
  /** `amount − paid`: lo que falta por cobrar. */
  pending: number;
};

export interface ComputedBalances {
  summary: StatementCurrencySummary[];
  plans: StatementPlanLine[];
  installments: StatementInstallment[];
  /** Por fecha de corte (la más antigua primero) y moneda. */
  openingBalances: StatementOpeningBalanceLine[];
}

export interface ComputedAccountStatement extends ComputedBalances {
  movements: StatementMovement[];
}

// ---------------------------------------------------------------------------
// Respuesta completa del endpoint.
// ---------------------------------------------------------------------------

export interface StatementPatient {
  id: string;
  firstName: string;
  lastName: string;
  docType: DocumentType;
  /** DX-327: nombre libre del documento (R7); null = sin etiqueta. */
  docTypeLabel: string | null;
  docNumber: string | null;
}

export interface StatementClinic {
  name: string;
  logoUrl: string | null;
}

/**
 * A nombre de quién sale el estado de cuenta (DX-203): el de un menor (menor
 * que la mayoría de edad de la clínica) o de un paciente sin email, a nombre
 * de su responsable que recibe avisos (primero el pagador principal); si no,
 * del propio paciente.
 */
export interface StatementAddressee {
  kind: 'PATIENT' | 'RESPONSIBLE';
  /** Nombre completo. */
  name: string;
  /** Email al que se le haría llegar; null si no tiene. */
  email: string | null;
}

export interface AccountStatement extends ComputedAccountStatement {
  issuedAt: Date;
  clinic: StatementClinic;
  /** En vivo, con el nombre visible de hoy (DX-327, R17). */
  patient: StatementPatient & { docTypeName: string };
  addressee: StatementAddressee;
  /** Filtro aplicado a `movements` (días civiles inclusive), o `null`. */
  range: { from: string | null; to: string | null };
}

// ---------------------------------------------------------------------------
// Estado de cuenta FAMILIAR del pagador (DX-203): solo importes y nombres.
// ---------------------------------------------------------------------------

/** Cifras de UNA moneda: las mismas del resumen individual. */
export interface FamilyCurrencyAmounts {
  currency: string;
  budgeted: number;
  /** Saldo migrado (DX-262), ya incluido en `balance`. */
  openingBalance: number;
  /** Lo que queda pendiente de él (QA D5). */
  openingPending: number;
  paid: number;
  balance: number;
  overdueAmount: number;
}

export interface FamilyStatementMember {
  patient: { id: string; firstName: string; lastName: string };
  /** Parentesco del pagador con el paciente; null = el propio pagador. */
  relationship: ResponsibleRelationship | null;
  self: boolean;
  /** Subtotal del paciente por moneda (= su estado de cuenta individual). */
  summary: FamilyCurrencyAmounts[];
}

export interface FamilyAccountStatement {
  issuedAt: Date;
  clinic: StatementClinic;
  payer: { id: string; firstName: string; lastName: string };
  members: FamilyStatementMember[];
  /** Suma de los subtotales, por moneda y al céntimo. */
  totals: FamilyCurrencyAmounts[];
}
