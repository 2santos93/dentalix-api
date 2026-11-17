import type {
  ClinicRole,
  CommissionBasis,
  CommissionLineKind,
  CommissionReleaseMode,
} from '@prisma/client';
import type { CurrencyTotal, SettlementPeriod } from './commission-calculator';
import type { CommissionCategoryPercent } from './commission-rule';
import type { CloseBlocker } from './settlement-period';

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

/** Una línea de la liquidación (vista previa o congelada). */
export interface CommissionLineView {
  /** null en la vista previa (aún no existe). */
  id: string | null;
  kind: CommissionLineKind;
  adjustsLineId: string | null;
  patient: { id: string; name: string | null };
  treatmentPlanId: string;
  treatmentPlanItemId: string;
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
  closedAt: Date;
  closedBy: { userId: string; name: string | null };
  lockDateBefore: string | null;
  lockDateAfter: string;
  totals: CurrencyTotal[];
}

export interface CommissionSettlementView extends CommissionSettlementSummary {
  categoryPercents: CommissionCategoryPercent[];
  lines: CommissionLineView[];
}
