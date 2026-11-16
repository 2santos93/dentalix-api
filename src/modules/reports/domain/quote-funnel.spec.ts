import { convertWithQuote } from '../../exchange/domain/exchange-rate-quote';
import { round2 } from '../../../shared/money/money';
import {
  buildQuoteFunnel,
  EMPTY_QUOTE_FUNNEL_SUMS,
  percentOf,
  planToCatalogAmount,
  QUOTE_FUNNEL_DEFINITION_KEYS,
  QUOTE_FUNNEL_DEFINITION_LIST,
  QUOTE_FUNNEL_DEFINITIONS,
  QUOTE_FUNNEL_STEPS,
  quoteFunnelWarnings,
  secondsToDays,
  sortRejectionReasons,
  type QuoteFunnelSums,
} from './quote-funnel';

const SUMS: QuoteFunnelSums = {
  ...EMPTY_QUOTE_FUNNEL_SUMS,
  presented: 10,
  presentedAmount: 2650,
  accepted: 4,
  acceptedAmount: 1000.004,
  scheduled: 2,
  scheduledAmount: 300,
  done: 1,
  doneAmount: 200,
  collected: 1,
  collectedAmount: 150.005,
  pending: 2,
  pendingAmount: 1000,
  rejected: 4,
  rejectedAmount: 650,
  withoutRate: 1,
  medianSecondsToAccept: 2.5 * 86_400,
};

describe('Embudo de presupuestos: dominio (DX-558)', () => {
  it('una definición por paso, tasa, mediana, desenlaces, motivos, profesional y moneda', () => {
    expect(Object.keys(QUOTE_FUNNEL_DEFINITIONS).sort()).toEqual(
      [...QUOTE_FUNNEL_DEFINITION_KEYS].sort(),
    );
    for (const key of QUOTE_FUNNEL_STEPS) {
      expect(QUOTE_FUNNEL_DEFINITIONS[key].howItIsCalculated.length).toBeGreaterThan(0);
    }
    expect(QUOTE_FUNNEL_DEFINITION_LIST.map((d) => d.key)).toEqual([
      ...QUOTE_FUNNEL_DEFINITION_KEYS,
    ]);
    for (const d of QUOTE_FUNNEL_DEFINITION_LIST) {
      expect(d.label).not.toBe('');
      expect(d.howItIsCalculated.every((line) => line.trim() !== '')).toBe(
        true,
      );
    }
  });

  it('percentOf: % con 1 decimal; sin base (0 o null) o sin parte, null', () => {
    expect(percentOf(4, 10)).toBe(40);
    expect(percentOf(1000, 2650)).toBe(37.7);
    expect(percentOf(1, 3)).toBe(33.3);
    expect(percentOf(0, 10)).toBe(0);
    expect(percentOf(3, 0)).toBeNull();
    expect(percentOf(null, 10)).toBeNull();
    expect(percentOf(1, null)).toBeNull();
  });

  it('secondsToDays: días con 1 decimal', () => {
    expect(secondsToDays(null)).toBeNull();
    expect(secondsToDays(86_400 * 2.5)).toBe(2.5);
    expect(secondsToDays(86_400 + 4 * 3600)).toBe(1.2);
  });

  it('planToCatalogAmount es la inversa de la tasa del ítem (catálogo → plan)', () => {
    const rate = { fromPerBase: 1, toPerBase: 36.5 };
    // 100 USD del catálogo son 3650 VES del plan; 4000 VES son 109,59 USD.
    expect(
      convertWithQuote(100, { from: 'USD', to: 'VES', ...rate }),
    ).toBe(3650);
    expect(planToCatalogAmount(3650, rate)).toBe(100);
    expect(round2(planToCatalogAmount(4000, rate))).toBe(109.59);
    // Entre dos monedas no base: × from ÷ to.
    const eurToVes = { fromPerBase: 0.9, toPerBase: 36.5 };
    const inPlan = convertWithQuote(90, {
      from: 'EUR',
      to: 'VES',
      ...eurToVes,
    });
    expect(round2(planToCatalogAmount(inPlan, eurToVes))).toBe(90);
  });

  it('buildQuoteFunnel: pasos en orden con su % sobre presentados y la tasa de aceptación', () => {
    const view = buildQuoteFunnel(SUMS, true);
    expect(view.steps.map((s) => s.key)).toEqual([...QUOTE_FUNNEL_STEPS]);
    expect(view.steps[0]).toEqual({
      key: 'PRESENTED',
      count: 10,
      amount: 2650,
      rateOfPresented: 100,
      amountRateOfPresented: 100,
    });
    expect(view.steps[1]).toEqual({
      key: 'ACCEPTED',
      count: 4,
      amount: 1000,
      rateOfPresented: 40,
      amountRateOfPresented: 37.7,
    });
    // El redondeo a 2 va al final de cada suma.
    expect(view.steps[4].amount).toBe(150.01);
    expect(view.acceptanceRate).toEqual({ byCount: 40, byAmount: 37.7 });
    expect(view.medianDaysToAccept).toBe(2.5);
    expect(view.outcomes).toEqual({
      pending: { count: 2, amount: 1000 },
      rejected: { count: 4, amount: 650 },
      cancelled: { count: 0, amount: 0 },
    });
    expect(view.withoutRate).toEqual({ presentations: 1 });
  });

  it('buildQuoteFunnel sin moneda de catálogo: importes y tasa por importe null', () => {
    const view = buildQuoteFunnel(SUMS, false);
    expect(view.steps.every((s) => s.amount === null)).toBe(true);
    expect(view.steps.every((s) => s.amountRateOfPresented === null)).toBe(
      true,
    );
    expect(view.acceptanceRate).toEqual({ byCount: 40, byAmount: null });
    expect(view.outcomes.pending).toEqual({ count: 2, amount: null });
    expect(view.withoutRate).toEqual({ presentations: 0 });
  });

  it('buildQuoteFunnel sin presentaciones: tasas null (la web pinta «—»)', () => {
    const view = buildQuoteFunnel(EMPTY_QUOTE_FUNNEL_SUMS, true);
    expect(view.steps.every((s) => s.rateOfPresented === null)).toBe(true);
    expect(view.acceptanceRate).toEqual({ byCount: null, byAmount: null });
    expect(view.medianDaysToAccept).toBeNull();
  });

  it('sortRejectionReasons: por número, luego importe (desc), y quita los vacíos', () => {
    const rows = [
      { reason: 'FEAR' as const, count: 1, amount: 300 },
      { reason: 'SECOND_OPINION' as const, count: 1, amount: 50.005 },
      { reason: 'PRICE' as const, count: 2, amount: 300 },
      { reason: 'OTHER' as const, count: 0, amount: 0 },
    ];
    expect(sortRejectionReasons(rows, true)).toEqual([
      { reason: 'PRICE', count: 2, amount: 300 },
      { reason: 'FEAR', count: 1, amount: 300 },
      { reason: 'SECOND_OPINION', count: 1, amount: 50.01 },
    ]);
    expect(sortRejectionReasons(rows, false).map((r) => r.amount)).toEqual([
      null,
      null,
      null,
    ]);
    // Empate total: el orden del catálogo.
    expect(
      sortRejectionReasons(
        [
          { reason: 'OTHER', count: 1, amount: 10 },
          { reason: 'PRICE', count: 1, amount: 10 },
        ],
        true,
      ).map((r) => r.reason),
    ).toEqual(['PRICE', 'OTHER']);
  });

  it('quoteFunnelWarnings: sin moneda de catálogo manda; sin tasa, aviso', () => {
    expect(quoteFunnelWarnings(null, 3)).toEqual(['NO_CATALOG_CURRENCY']);
    expect(quoteFunnelWarnings('USD', 2)).toEqual(['WITHOUT_RATE']);
    expect(quoteFunnelWarnings('USD', 0)).toEqual([]);
  });
});
