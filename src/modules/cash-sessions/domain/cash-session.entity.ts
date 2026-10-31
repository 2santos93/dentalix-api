import type {
  CashAdjustmentKind,
  CashSessionStatus,
  PaymentMethod,
} from '@prisma/client';

/*
 * Caja por turno (DX-027): la caja de UN usuario en UNA sede, con su fondo
 * inicial por moneda, los abonos que recibió, los ajustes que le llegaron de
 * cajas ya cerradas y sus cierres (arqueo por moneda y método). Importes en la
 * unidad de la moneda (2 decimales), como el resto de la API.
 */

export const CASH_NOTES_MAX = 500;
export const CASH_REASON_MIN = 3;
export const CASH_REASON_MAX = 300;
export const CASH_DIFFERENCE_REASON_MAX = 500;
/** Monedas distintas en el fondo o en el arqueo (sobra: hay ~10 en el catálogo). */
export const CASH_MAX_CURRENCIES = 20;
/** Tope de un importe (DECIMAL(14,2)). */
export const CASH_MAX_AMOUNT = 999_999_999_999.99;

export interface StaffRef {
  id: string;
  /** `null` si ya no es resoluble (usuario fuera de la clínica). */
  fullName: string | null;
}

export interface LocationRef {
  id: string;
  name: string;
}

export interface CashSettings {
  /** «Exigir caja abierta»: sin caja abierta no se cobra en efectivo. */
  requireOpenSession: boolean;
  /** «Arqueo ciego»: se cuenta antes de ver el esperado. */
  blindClose: boolean;
}

export interface MoneyAmount {
  currency: string;
  amount: number;
}

export interface CashExpectedLine {
  currency: string;
  method: PaymentMethod;
  opening: number;
  payments: number;
  paymentsCount: number;
  adjustments: number;
  /** Salidas de caja menor (DX-274), en positivo: se restan. */
  outflows: number;
  outflowsCount: number;
  /** opening + payments + adjustments − outflows (puede ser negativo). */
  expected: number;
}

export interface CashClosingLine {
  currency: string;
  method: PaymentMethod;
  opening: number;
  expected: number;
  counted: number;
  difference: number;
}

export interface CashClosingView {
  id: string;
  sequence: number;
  closedAt: Date;
  closedBy: StaffRef;
  blind: boolean;
  hasDifference: boolean;
  differenceReason: string | null;
  notes: string | null;
  /** Día civil (YYYY-MM-DD) que DX-091 podrá usar como fecha de bloqueo. */
  suggestedLockDate: string;
  lines: CashClosingLine[];
}

export interface CashReopeningView {
  id: string;
  sequence: number;
  reopenedAt: Date;
  reopenedBy: StaffRef;
  reason: string;
}

export interface CashSessionPayment {
  id: string;
  paidAt: Date;
  /** Día civil del abono en la zona de la sede. */
  paidOn: string;
  amount: number;
  currency: string;
  method: PaymentMethod | null;
  receiptNumber: string | null;
  patient: { id: string; fullName: string };
  createdBy: StaffRef | null;
}

export interface CashVoidedPayment extends CashSessionPayment {
  voidedAt: Date | null;
  voidedBy: StaffRef | null;
  voidReason: string | null;
  /**
   * `true` si se anuló con la caja ya cerrada: sigue contando aquí (la caja no
   * cambia) y la anulación es un ajuste en otra caja.
   */
  bookedAsAdjustment: boolean;
}

/**
 * Salida de caja menor (DX-274): un pago de gasto desde el cajón, siempre en
 * efectivo. Se ve también con el arqueo ciego (la registró quien cuenta).
 */
export interface CashOutflow {
  /** Id del pago de gasto. */
  id: string;
  expenseId: string;
  category: string;
  supplier: string | null;
  amount: number;
  currency: string;
  createdAt: Date;
  createdBy: StaffRef;
}

/**
 * DX-253: devolución de saldo a favor en efectivo desde el cajón: un egreso
 * de la caja (resta en el esperado de CASH). Inmutable: no se anula.
 */
export interface CashCreditRefund {
  id: string;
  /** Número del comprobante de devolución (`DEV-BOG-000001`). */
  number: string;
  amount: number;
  currency: string;
  reason: string;
  createdAt: Date;
  createdBy: StaffRef;
  patient: { id: string; fullName: string };
}

export interface CashVoidedOutflow extends CashOutflow {
  voidedAt: Date | null;
  voidedBy: StaffRef | null;
  voidReason: string | null;
  /**
   * `true` si se anuló con la caja ya cerrada: sigue restando aquí y la
   * anulación es un ajuste OUTFLOW_VOID (positivo) en otra caja.
   */
  bookedAsAdjustment: boolean;
}

export interface CashSessionRef {
  id: string;
  openedAt: Date;
  openedBy: StaffRef;
}

export interface CashAdjustmentView {
  id: string;
  kind: CashAdjustmentKind;
  currency: string;
  method: PaymentMethod;
  amount: number;
  reason: string | null;
  createdAt: Date;
  createdBy: StaffRef;
  /** Caja donde cuenta; `null` = pendiente de la siguiente que se abra. */
  sessionId: string | null;
  payment: {
    id: string;
    patient: { id: string; fullName: string };
    paidOn: string;
    receiptNumber: string | null;
  } | null;
  /** OUTFLOW_VOID: la salida de caja anulada y su gasto. */
  expensePayment: {
    id: string;
    expenseId: string;
    category: string;
    supplier: string | null;
  } | null;
  /** Caja cerrada de la que viene (el enlace al original). */
  originalSession: CashSessionRef | null;
}

export interface CashSessionSummary {
  id: string;
  status: CashSessionStatus;
  location: LocationRef;
  openedBy: StaffRef;
  openedAt: Date;
  /** Día civil de la apertura en la zona de la sede. */
  openedOn: string;
  closedAt: Date | null;
  closedBy: StaffRef | null;
  reopenCount: number;
  floats: MoneyAmount[];
  /** Diferencia por moneda del último cierre (vacía si está abierta). */
  differences: MoneyAmount[];
}

export interface CashSessionDetail extends CashSessionSummary {
  notes: string | null;
  timeZone: string;
  /** Arqueo ciego activo para quien consulta: sin esperado ni abonos. */
  blindHidden: boolean;
  expected: CashExpectedLine[] | null;
  payments: CashSessionPayment[] | null;
  voidedPayments: CashVoidedPayment[];
  /** Salidas de caja vivas del turno (DX-274). */
  outflows: CashOutflow[];
  /** Salidas anuladas (las anuladas con la caja cerrada siguen restando). */
  voidedOutflows: CashVoidedOutflow[];
  /** DX-253: devoluciones de saldo a favor en efectivo (restan en CASH). */
  creditRefunds: CashCreditRefund[];
  adjustments: CashAdjustmentView[];
  /** Ajustes que nacieron de esta caja ya cerrada y cuentan en otra. */
  laterAdjustments: CashAdjustmentView[];
  /** Último cierre (el vigente si está cerrada). */
  closing: CashClosingView | null;
  closings: CashClosingView[];
  reopenings: CashReopeningView[];
  can: { close: boolean; reopen: boolean; adjust: boolean };
}

/** Quién consulta o actúa, del token. */
export interface CashActor {
  userId: string;
  isAdmin: boolean;
}
