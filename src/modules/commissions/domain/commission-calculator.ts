import type { CommissionLineKind } from '@prisma/client';
import { fromCents, roundCents, toCents } from '../../../shared/money/money';
import { civilDateIn } from '../../../shared/time/civil-day';
import { percentFor, type CommissionRuleTerms } from './commission-rule';

/**
 * DX-018: el cálculo de la liquidación, sin base de datos. Cada importe va en
 * la moneda del plan del ítem (la imputación de DX-051 ya está en ella) y los
 * totales se agrupan por moneda: nunca se suman monedas distintas.
 */

/** Período de la liquidación: días civiles, ambos inclusive. */
export interface SettlementPeriod {
  from: string;
  to: string;
}

/** Una imputación de un abono vivo a un ítem (DX-051), aún sin liquidar a este profesional. */
export interface CandidateAllocation {
  paymentId: string;
  /** En la moneda del plan. */
  amount: number;
  paidAt: Date;
  /** El abono tal como se cobró (su importe y su moneda). */
  paymentAmount: number;
  paymentCurrency: string;
  /** % que la pasarela cobra a la clínica por el medio de pago del abono (DX-018-bis); null sin él. */
  cardFeePercent: number | null;
}

/** Un ítem DONE realizado por el profesional, con lo que aún no se le liquidó. */
export interface CandidateItem {
  itemId: string;
  planId: string;
  patientId: string;
  /** Sede donde se realizó: su zona fija el día civil. */
  locationId: string;
  timeZone: string;
  catalogCode: string;
  catalogLabel: string;
  category: string | null;
  toothNumber: string;
  currency: string;
  /** Precio − descuento, en la moneda del plan. */
  net: number;
  completedAt: Date;
  /** Para la base «producido»: el ítem aún no se le liquidó a este profesional. */
  producedPending: boolean;
  /** Para la base «cobrado»: imputaciones aún no liquidadas. */
  allocations: CandidateAllocation[];
  /**
   * DX-018-bis: costo de laboratorio del ítem en la moneda del plan (sus
   * órdenes vivas); null sin costo en esa moneda.
   */
  labCost: number | null;
  /** Monedas de costos de laboratorio del ítem distintas a la del plan: no se convierten ni se descuentan. */
  labCostSkippedCurrencies: string[];
}

/** Lo que hace falta para saber si un plan está completo y pagado (PER_PLAN). */
export interface PlanReleaseInfo {
  planId: string;
  /** Ítems vivos aceptados que aún no se han realizado. */
  pendingItems: number;
  /** Ítems vivos realizados. */
  doneItems: number;
  /** Realizados cuyas imputaciones no cubren precio − descuento. */
  unpaidDoneItems: number;
  lastCompletedAt: Date | null;
  /** El último abono vivo imputado a un ítem del plan. */
  lastPaidAt: Date | null;
}

export interface CommissionLineDraft {
  kind: CommissionLineKind;
  adjustsLineId: string | null;
  itemId: string;
  planId: string;
  patientId: string;
  paymentId: string | null;
  locationId: string | null;
  catalogCode: string;
  catalogLabel: string;
  category: string | null;
  toothNumber: string;
  completedAt: Date | null;
  paidAt: Date | null;
  paymentAmount: number | null;
  paymentCurrency: string | null;
  releasedAt: Date | null;
  currency: string;
  base: number;
  percent: number;
  amount: number;
  /** DX-018-bis: base antes de descuentos (base = bruta − laboratorio − pasarela). */
  grossBase: number;
  labCostDeducted: number;
  /** % de la pasarela aplicado; null si no se descontó. */
  cardFeePercent: number | null;
  cardFeeDeducted: number;
  /** Costos de laboratorio en otra moneda: avisados y no descontados. */
  labCostSkippedCurrencies: string[];
}

const later = (a: Date, b: Date): Date => (a.getTime() >= b.getTime() ? a : b);

/**
 * Cuándo queda «completo y pagado» un plan (PER_PLAN): sin ítems aceptados por
 * hacer, al menos uno realizado y cada realizado cubierto por sus
 * imputaciones. La fecha es la más tardía entre el último realizado y el
 * último abono imputado. `null` si aún no se libera.
 */
export function planReleasedAt(info: PlanReleaseInfo): Date | null {
  if (info.pendingItems > 0 || info.doneItems === 0) return null;
  if (info.unpaidDoneItems > 0) return null;
  if (info.lastCompletedAt === null) return null;
  return info.lastPaidAt === null
    ? info.lastCompletedAt
    : later(info.lastCompletedAt, info.lastPaidAt);
}

/** El honorario de una base con un %: redondeado al centavo. */
export function commissionOf(base: number, percent: number): number {
  return fromCents(roundCents((toCents(base) * percent) / 100));
}

/**
 * DX-018-bis: los costos de laboratorio de un ítem (sus órdenes vivas) en la
 * moneda del plan, sumados al centavo; los de otra moneda no se convierten:
 * se devuelven aparte para avisar y no se descuentan.
 */
export function labCostOf(
  currency: string,
  costs: readonly { amount: number; currency: string }[],
): { labCost: number | null; skippedCurrencies: string[] } {
  let cents = 0;
  let any = false;
  const skipped = new Set<string>();
  for (const cost of costs) {
    if (cost.currency === currency) {
      cents += toCents(cost.amount);
      any = true;
    } else {
      skipped.add(cost.currency);
    }
  }
  return {
    labCost: any ? fromCents(cents) : null,
    skippedCurrencies: [...skipped].sort(),
  };
}

/** Una base con sus descuentos: base = bruta − laboratorio − pasarela. */
export interface DeductedBase {
  gross: number;
  labCost: number;
  /** El % de la pasarela aplicado; null si no se descontó. */
  cardFeePercent: number | null;
  cardFee: number;
  base: number;
}

/** Descuenta al centavo: primero el laboratorio, luego la pasarela; nunca bajo 0. */
function deducted(
  grossCents: number,
  labCents: number,
  cardFeePercent: number | null,
): DeductedBase {
  const lab = Math.min(Math.max(0, labCents), Math.max(0, grossCents));
  const fee =
    cardFeePercent === null
      ? 0
      : Math.min(
          roundCents((grossCents * cardFeePercent) / 100),
          Math.max(0, grossCents - lab),
        );
  return {
    gross: fromCents(grossCents),
    labCost: fromCents(lab),
    cardFeePercent,
    cardFee: fromCents(fee),
    base: fromCents(Math.max(0, grossCents - lab - fee)),
  };
}

/**
 * La base después de los descuentos que la regla tenga activos: el costo de
 * laboratorio (en proporción a la parte del ítem que cubre esta base) y la
 * comisión de la pasarela del abono, con lo descontado de cada uno.
 */
export function applyDeductions(
  gross: number,
  terms: Pick<CommissionRuleTerms, 'deductLabCost' | 'deductCardFee'>,
  deductions: {
    labCost: number | null;
    itemNet: number;
    cardFeePercent: number | null;
  },
): DeductedBase {
  const grossCents = toCents(gross);
  const labCents =
    terms.deductLabCost && deductions.labCost !== null && deductions.itemNet > 0
      ? roundCents(
          toCents(deductions.labCost) *
            (grossCents / toCents(deductions.itemNet)),
        )
      : 0;
  const cardFeePercent =
    terms.deductCardFee &&
    deductions.cardFeePercent !== null &&
    deductions.cardFeePercent > 0
      ? deductions.cardFeePercent
      : null;
  return deducted(grossCents, labCents, cardFeePercent);
}

/** La base después de los descuentos (ver `applyDeductions`). Nunca negativa. */
export function baseAfterDeductions(
  gross: number,
  terms: Pick<CommissionRuleTerms, 'deductLabCost' | 'deductCardFee'>,
  deductions: {
    labCost: number | null;
    itemNet: number;
    cardFeePercent: number | null;
  },
): number {
  return applyDeductions(gross, terms, deductions).base;
}

function inPeriod(
  instant: Date,
  timeZone: string,
  period: SettlementPeriod,
): boolean {
  const day = civilDateIn(instant, timeZone);
  return day >= period.from && day <= period.to;
}

/** Lo que la línea congela de sus descuentos. */
function frozenOf(
  d: DeductedBase,
  terms: Pick<CommissionRuleTerms, 'deductLabCost'>,
  item: Pick<CandidateItem, 'labCostSkippedCurrencies'>,
): Pick<
  CommissionLineDraft,
  | 'base'
  | 'grossBase'
  | 'labCostDeducted'
  | 'cardFeePercent'
  | 'cardFeeDeducted'
  | 'labCostSkippedCurrencies'
> {
  return {
    base: d.base,
    grossBase: d.gross,
    labCostDeducted: d.labCost,
    cardFeePercent: d.cardFeePercent,
    cardFeeDeducted: d.cardFee,
    labCostSkippedCurrencies: terms.deductLabCost
      ? [...item.labCostSkippedCurrencies]
      : [],
  };
}

/**
 * Los devengos del período: por ítem (producido) o por imputación abono→ítem
 * (cobrado), los que se liberan dentro del período en el día civil de la sede
 * donde se realizó el ítem.
 *   PRODUCED + PER_ITEM: al realizarse.
 *   COLLECTED + PER_ITEM: al realizarse Y cobrarse (lo más tardío).
 *   PER_PLAN: cuando el plan queda completo y pagado.
 */
export function accrualLines(
  items: readonly CandidateItem[],
  terms: CommissionRuleTerms,
  period: SettlementPeriod,
  planRelease: ReadonlyMap<string, Date | null>,
): CommissionLineDraft[] {
  const lines: CommissionLineDraft[] = [];
  for (const item of items) {
    const percent = percentFor(terms, item.category);
    const common = {
      kind: 'ACCRUAL' as const,
      adjustsLineId: null,
      itemId: item.itemId,
      planId: item.planId,
      patientId: item.patientId,
      locationId: item.locationId,
      catalogCode: item.catalogCode,
      catalogLabel: item.catalogLabel,
      category: item.category,
      toothNumber: item.toothNumber,
      completedAt: item.completedAt,
      currency: item.currency,
      percent,
    };
    const planDate =
      terms.releaseMode === 'PER_PLAN'
        ? (planRelease.get(item.planId) ?? null)
        : null;
    if (terms.basis === 'PRODUCED') {
      if (!item.producedPending) continue;
      const releasedAt =
        terms.releaseMode === 'PER_PLAN' ? planDate : item.completedAt;
      if (releasedAt === null || !inPeriod(releasedAt, item.timeZone, period))
        continue;
      const d = applyDeductions(item.net, terms, {
        labCost: item.labCost,
        itemNet: item.net,
        cardFeePercent: null,
      });
      if (d.base <= 0) continue;
      lines.push({
        ...common,
        paymentId: null,
        paidAt: null,
        paymentAmount: null,
        paymentCurrency: null,
        releasedAt,
        ...frozenOf(d, terms, item),
        amount: commissionOf(d.base, percent),
      });
      continue;
    }
    for (const allocation of item.allocations) {
      const releasedAt =
        terms.releaseMode === 'PER_PLAN'
          ? planDate
          : later(allocation.paidAt, item.completedAt);
      if (releasedAt === null || !inPeriod(releasedAt, item.timeZone, period))
        continue;
      const d = applyDeductions(allocation.amount, terms, {
        labCost: item.labCost,
        itemNet: item.net,
        cardFeePercent: allocation.cardFeePercent,
      });
      if (d.base <= 0) continue;
      lines.push({
        ...common,
        paymentId: allocation.paymentId,
        paidAt: allocation.paidAt,
        paymentAmount: allocation.paymentAmount,
        paymentCurrency: allocation.paymentCurrency,
        releasedAt,
        ...frozenOf(d, terms, item),
        amount: commissionOf(d.base, percent),
      });
    }
  }
  return lines.sort(
    (a, b) =>
      (a.releasedAt?.getTime() ?? 0) - (b.releasedAt?.getTime() ?? 0) ||
      a.itemId.localeCompare(b.itemId) ||
      (a.paymentId ?? '').localeCompare(b.paymentId ?? ''),
  );
}

/** Un devengo ya liquidado (congelado) con lo que vale hoy su base. */
export interface SettledLine {
  lineId: string;
  itemId: string;
  planId: string;
  patientId: string;
  paymentId: string | null;
  locationId: string | null;
  catalogCode: string;
  catalogLabel: string;
  category: string | null;
  toothNumber: string;
  completedAt: Date | null;
  paidAt: Date | null;
  paymentAmount: number | null;
  paymentCurrency: string | null;
  currency: string;
  /** El % congelado de la línea original. */
  percent: number;
  /** Base liquidada: la línea más sus ajustes anteriores. */
  settledBase: number;
  /** Honorario liquidado: la línea más sus ajustes anteriores. */
  settledAmount: number;
  /** DX-018-bis: base bruta, laboratorio y pasarela liquidados (línea + ajustes). */
  settledGross: number;
  settledLabCost: number;
  settledCardFee: number;
  /** Lo congelado en la línea original: su base bruta, su laboratorio y su % de pasarela. */
  originalGross: number;
  originalLabCost: number;
  cardFeePercent: number | null;
  /**
   * La base BRUTA que tendría hoy: la imputación de un abono vivo a un ítem
   * vivo realizado por el mismo profesional (cobrado) o precio − descuento del
   * ítem (producido); 0 si el abono se anuló, el ítem se borró, dejó de estar
   * realizado o cambió de profesional.
   */
  currentGross: number;
}

/**
 * DX-018-bis: la base de hoy con los descuentos CONGELADOS de la línea
 * original (el laboratorio en proporción a la base bruta nueva, el mismo % de
 * pasarela). Cambiar después el costo, el % o la regla no mueve lo liquidado.
 */
export function frozenDeductions(
  line: Pick<
    SettledLine,
    'currentGross' | 'originalGross' | 'originalLabCost' | 'cardFeePercent'
  >,
): DeductedBase {
  const grossCents = toCents(line.currentGross);
  const originalCents = toCents(line.originalGross);
  const labCents =
    originalCents > 0
      ? roundCents(toCents(line.originalLabCost) * (grossCents / originalCents))
      : 0;
  return deducted(grossCents, labCents, line.cardFeePercent);
}

/**
 * Los ajustes de liquidaciones anteriores: la diferencia entre lo que vale hoy
 * cada línea liquidada y lo ya liquidado, con su % y sus descuentos congelados. El honorario del
 * ajuste lleva lo liquidado exactamente a lo que tocaría hoy (un abono anulado
 * deja la línea en 0 al centavo).
 */
export function adjustmentLines(
  settled: readonly SettledLine[],
): CommissionLineDraft[] {
  const lines: CommissionLineDraft[] = [];
  for (const line of settled) {
    const current = frozenDeductions(line);
    const baseDelta = toCents(current.base) - toCents(line.settledBase);
    if (baseDelta === 0) continue;
    const target = commissionOf(current.base, line.percent);
    lines.push({
      kind: 'ADJUSTMENT',
      adjustsLineId: line.lineId,
      itemId: line.itemId,
      planId: line.planId,
      patientId: line.patientId,
      paymentId: line.paymentId,
      locationId: line.locationId,
      catalogCode: line.catalogCode,
      catalogLabel: line.catalogLabel,
      category: line.category,
      toothNumber: line.toothNumber,
      completedAt: line.completedAt,
      paidAt: line.paidAt,
      paymentAmount: line.paymentAmount,
      paymentCurrency: line.paymentCurrency,
      releasedAt: null,
      currency: line.currency,
      base: fromCents(baseDelta),
      percent: line.percent,
      amount: fromCents(toCents(target) - toCents(line.settledAmount)),
      grossBase: fromCents(toCents(current.gross) - toCents(line.settledGross)),
      labCostDeducted: fromCents(
        toCents(current.labCost) - toCents(line.settledLabCost),
      ),
      cardFeePercent: line.cardFeePercent,
      cardFeeDeducted: fromCents(
        toCents(current.cardFee) - toCents(line.settledCardFee),
      ),
      labCostSkippedCurrencies: [],
    });
  }
  return lines;
}

export interface CurrencyTotal {
  currency: string;
  /** Devengado del período. */
  accrued: number;
  /** Ajustes de liquidaciones anteriores (con signo). */
  adjustments: number;
  /** A pagar: devengado + ajustes. */
  total: number;
  lines: number;
}

/** Totales por moneda (nunca se suman monedas distintas), ordenados por código. */
export function totalsByCurrency(
  lines: readonly Pick<CommissionLineDraft, 'kind' | 'currency' | 'amount'>[],
): CurrencyTotal[] {
  const acc = new Map<
    string,
    { accrued: number; adjustments: number; lines: number }
  >();
  for (const line of lines) {
    const row = acc.get(line.currency) ?? {
      accrued: 0,
      adjustments: 0,
      lines: 0,
    };
    if (line.kind === 'ACCRUAL') row.accrued += toCents(line.amount);
    else row.adjustments += toCents(line.amount);
    row.lines += 1;
    acc.set(line.currency, row);
  }
  return [...acc.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, row]) => ({
      currency,
      accrued: fromCents(row.accrued),
      adjustments: fromCents(row.adjustments),
      total: fromCents(row.accrued + row.adjustments),
      lines: row.lines,
    }));
}
