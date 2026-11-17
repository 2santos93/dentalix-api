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
  /** % que la pasarela cobra a la clínica por el medio de pago; hoy no existe (null). */
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
  /** Costo de laboratorio del ítem; hoy no existe (null). */
  labCost: number | null;
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
 * La base después de los descuentos que la regla tenga activos: el costo de
 * laboratorio (en proporción a la parte del ítem que cubre esta base) y la
 * comisión de la pasarela del abono. Nunca negativa.
 */
export function baseAfterDeductions(
  gross: number,
  terms: Pick<CommissionRuleTerms, 'deductLabCost' | 'deductCardFee'>,
  deductions: {
    labCost: number | null;
    itemNet: number;
    cardFeePercent: number | null;
  },
): number {
  let cents = toCents(gross);
  if (
    terms.deductLabCost &&
    deductions.labCost !== null &&
    deductions.itemNet > 0
  ) {
    const share =
      toCents(deductions.labCost) *
      (toCents(gross) / toCents(deductions.itemNet));
    cents -= roundCents(share);
  }
  if (terms.deductCardFee && deductions.cardFeePercent !== null) {
    cents -= roundCents((toCents(gross) * deductions.cardFeePercent) / 100);
  }
  return fromCents(Math.max(0, cents));
}

function inPeriod(
  instant: Date,
  timeZone: string,
  period: SettlementPeriod,
): boolean {
  const day = civilDateIn(instant, timeZone);
  return day >= period.from && day <= period.to;
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
      const base = baseAfterDeductions(item.net, terms, {
        labCost: item.labCost,
        itemNet: item.net,
        cardFeePercent: null,
      });
      if (base <= 0) continue;
      lines.push({
        ...common,
        paymentId: null,
        paidAt: null,
        paymentAmount: null,
        paymentCurrency: null,
        releasedAt,
        base,
        amount: commissionOf(base, percent),
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
      const base = baseAfterDeductions(allocation.amount, terms, {
        labCost: item.labCost,
        itemNet: item.net,
        cardFeePercent: allocation.cardFeePercent,
      });
      if (base <= 0) continue;
      lines.push({
        ...common,
        paymentId: allocation.paymentId,
        paidAt: allocation.paidAt,
        paymentAmount: allocation.paymentAmount,
        paymentCurrency: allocation.paymentCurrency,
        releasedAt,
        base,
        amount: commissionOf(base, percent),
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
  /**
   * La base que tendría hoy: la imputación de un abono vivo a un ítem vivo
   * realizado por el mismo profesional (cobrado) o precio − descuento del ítem
   * (producido); 0 si el abono se anuló, el ítem se borró, dejó de estar
   * realizado o cambió de profesional.
   */
  currentBase: number;
}

/**
 * Los ajustes de liquidaciones anteriores: la diferencia entre lo que vale hoy
 * cada línea liquidada y lo ya liquidado, con su % congelado. El honorario del
 * ajuste lleva lo liquidado exactamente a lo que tocaría hoy (un abono anulado
 * deja la línea en 0 al centavo).
 */
export function adjustmentLines(
  settled: readonly SettledLine[],
): CommissionLineDraft[] {
  const lines: CommissionLineDraft[] = [];
  for (const line of settled) {
    const baseDelta = toCents(line.currentBase) - toCents(line.settledBase);
    if (baseDelta === 0) continue;
    const target = commissionOf(line.currentBase, line.percent);
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
