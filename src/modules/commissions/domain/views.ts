import type {
  ClinicRole,
  PaymentMethod,
  CommissionBasis,
  CommissionLineKind,
  CommissionReleaseMode,
} from '@prisma/client';
import type { CurrencyTotal, SettlementPeriod } from './commission-calculator';
import type { CommissionCategoryPercent } from './commission-rule';
import type { CloseBlocker } from './settlement-period';
import type {
  CurrencyPaymentState,
  SettlementPaymentStatus,
} from './settlement-payments';

/** DX-018: lo que devuelven las rutas de honorarios. */

export interface ProfessionalView {
  userId: string;
  membershipId: string;
  name: string;
  role: ClinicRole;
  active: boolean;
}

export interface RuleView {
  id: string;
  basis: CommissionBasis;
  releaseMode: CommissionReleaseMode;
  percent: number;
  categories: CommissionCategoryPercent[];
  active: boolean;
  deductLabCost: boolean;
  deductCardFee: boolean;
  updatedAt: Date;
}

/** Descuentos que la regla podría aplicar y si hoy se pueden activar. */
export interface DeductionsAvailability {
  labCost: boolean;
  cardFee: boolean;
}

export interface ProfessionalRuleView {
  professional: ProfessionalView;
  rule: RuleView | null;
}

export interface CommissionRulesView {
  professionals: ProfessionalRuleView[];
  /** Categorías del catálogo de la clínica (para el % por categoría). */
  categories: string[];
  deductionsAvailable: DeductionsAvailability;
}

/**
 * DX-018-bis: los descuentos de una línea: base = grossBase − labCost −
 * cardFee. Sin descuentos (o en las líneas anteriores), grossBase = base.
 */
export interface CommissionLineDeductionsView {
  grossBase: number;
  labCost: number;
  /** El % de la pasarela aplicado; null si no se descontó. */
  cardFeePercent: number | null;
  cardFee: number;
  /** Costos de laboratorio en otra moneda que la del plan: no se convierten ni se descuentan. */
  labCostSkippedCurrencies: string[];
}

/** Una línea de la liquidación (vista previa o congelada). */
export interface CommissionLineView {
  /** null en la vista previa (aún no existe). */
  id: string | null;
  kind: CommissionLineKind;
  adjustsLineId: string | null;
  patient: { id: string; name: string | null };
  treatmentPlanId: string;
  treatmentPlanItemId: string;
  /** Sede donde se realizó el ítem: la de sus fechas e importes en pantalla. */
  locationId: string | null;
  catalogCode: string;
  catalogLabel: string;
  category: string | null;
  toothNumber: string;
  completedAt: Date | null;
  /** Cobrado: el abono (su importe y moneda tal como se cobró). */
  payment: {
    id: string;
    paidAt: Date;
    amount: number;
    currency: string;
  } | null;
  releasedAt: Date | null;
  /** Moneda de la línea (la del plan). */
  currency: string;
  base: number;
  percent: number;
  amount: number;
  deductions: CommissionLineDeductionsView;
  /** DX-464: el pago (vivo) de la liquidación que cubre la línea; null en la vista previa o pendiente. */
  paidInPaymentId: string | null;
}

export interface CommissionPreviewView {
  professional: ProfessionalView;
  period: SettlementPeriod;
  rule: RuleView | null;
  lines: CommissionLineView[];
  totals: CurrencyTotal[];
  /** El «hasta» de la última liquidación cerrada, si hay. */
  lastClosedTo: string | null;
  /** Desde dónde debería empezar la siguiente (día después de la última). */
  nextFrom: string | null;
  canClose: boolean;
  blocker: CloseBlocker | null;
  blockerMessage: string | null;
  deductionsAvailable: DeductionsAvailability;
}

export interface CommissionSettlementSummary {
  id: string;
  professional: ProfessionalView;
  period: SettlementPeriod;
  basis: CommissionBasis;
  releaseMode: CommissionReleaseMode;
  percent: number;
  /** DX-018-bis: los descuentos de la regla al cerrar. */
  deductLabCost: boolean;
  deductCardFee: boolean;
  closedAt: Date;
  closedBy: { userId: string; name: string | null };
  lockDateBefore: string | null;
  lockDateAfter: string;
  totals: CurrencyTotal[];
  /** DX-464: estado de pago, por moneda y global (derivado de los pagos vivos). */
  payment: SettlementPaymentSummaryView;
}

/** DX-464: «Pendiente», «Pagada parcialmente», «Pagada» o «Sin importe a pagar». */
export interface SettlementPaymentSummaryView {
  status: SettlementPaymentStatus;
  currencies: CurrencyPaymentState[];
}

/** DX-464: la conformidad del profesional con un pago. */
export type CommissionReceiptStatus = 'NONE' | 'PENDING' | 'EXPIRED' | 'SIGNED';

export interface CommissionPaymentReceiptView {
  status: CommissionReceiptStatus;
  /** El último enlace pedido (vivo, caducado o firmado). */
  requestedAt: Date | null;
  expiresAt: Date | null;
  signedAt: Date | null;
  signerName: string | null;
}

/** DX-464: un pago de la liquidación y el gasto de la sede que lo refleja. */
export interface CommissionPaymentView {
  id: string;
  settlementId: string;
  currency: string;
  amount: number;
  method: PaymentMethod;
  /** Día del pago (AAAA-MM-DD). */
  paidOn: string;
  reference: string | null;
  location: { id: string; name: string };
  expenseId: string;
  /** Líneas de la liquidación que cubre. */
  lineIds: string[];
  createdAt: Date;
  createdBy: { userId: string; name: string | null };
  voidedAt: Date | null;
  voidedBy: { userId: string; name: string | null } | null;
  voidReason: string | null;
  receipt: CommissionPaymentReceiptView;
}

export interface CommissionSettlementView extends CommissionSettlementSummary {
  categoryPercents: CommissionCategoryPercent[];
  lines: CommissionLineView[];
  /** DX-464: pagos (vivos y anulados), del más reciente al más antiguo. */
  payments: CommissionPaymentView[];
  /** DX-464: email de la cuenta del profesional (para «Enviar» por email). */
  professionalEmail: string | null;
}
