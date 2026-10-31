/*
 * «Producción por procedimiento» (DX-423). La base de datos suma, por
 * procedimiento del catálogo y moneda del plan, los ítems REALIZADOS del
 * período; aquí solo se dividen esas sumas y se agrupan en subtotales.
 *
 *  - Bruto = Σ precio; descuentos = Σ descuento; neto = bruto − descuentos.
 *  - Honorario medio = neto ÷ cantidad.
 *  - Medio de catálogo = Σ precio de catálogo congelado en el ítem
 *    (`basePrice`, DX-105) ÷ los ítems que lo tienen.
 *  - Diferencia % = (neto de los ítems con catálogo − su catálogo) ÷ su
 *    catálogo: compara cada ítem con SU precio de catálogo, así los ítems
 *    anteriores a DX-105 (sin precio congelado) no la sesgan.
 *
 * Los importes NUNCA se suman entre monedas: los subtotales de categoría y los
 * totales van por moneda.
 */

export const UNCATEGORIZED_LABEL = 'Sin categoría';

/** Lo que suma la base de datos por procedimiento y moneda. */
export interface ProcedureSums {
  catalogItemId: string;
  code: string;
  label: string;
  /** null = el procedimiento no tiene categoría en el catálogo. */
  category: string | null;
  currency: string;
  count: number;
  gross: number;
  discounts: number;
  /** Ítems con precio de catálogo congelado (`basePrice` no nulo). */
  catalogCount: number;
  /** Σ `basePrice` de esos ítems. */
  catalogSum: number;
  /** Σ neto (precio − descuento) de esos mismos ítems. */
  catalogPricedNet: number;
}

export interface AmountTotals {
  currency: string;
  count: number;
  gross: number;
  discounts: number;
  net: number;
  /** Neto ÷ cantidad, 2 decimales. */
  averageNet: number;
}

export interface ProcedureRow extends AmountTotals {
  catalogItemId: string;
  code: string;
  label: string;
  category: string | null;
  /** null = ningún ítem tiene precio de catálogo congelado. */
  catalogAverage: number | null;
  catalogCount: number;
  /** % del honorario cobrado frente al de catálogo, 1 decimal; null sin base. */
  differencePercent: number | null;
}

export interface CategoryTotals extends AmountTotals {
  category: string | null;
}

export interface ProcedureProduction {
  rows: ProcedureRow[];
  categoryTotals: CategoryTotals[];
  totals: AmountTotals[];
}

/** Redondeo a `decimals` decimales, a la mitad hacia arriba. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

const money = (value: number) => round(value, 2);

function compareText(a: string, b: string): number {
  return a.localeCompare(b, 'es', { sensitivity: 'base', numeric: true });
}

/** Categorías por nombre, «Sin categoría» al final. */
function compareCategory(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareText(a, b);
}

function totalsOf(
  currency: string,
  count: number,
  gross: number,
  discounts: number,
): AmountTotals {
  const net = money(gross - discounts);
  return {
    currency,
    count,
    gross: money(gross),
    discounts: money(discounts),
    net,
    averageNet: count === 0 ? 0 : money(net / count),
  };
}

function rowOf(s: ProcedureSums): ProcedureRow {
  const base = totalsOf(s.currency, s.count, s.gross, s.discounts);
  const catalogAverage =
    s.catalogCount === 0 ? null : money(s.catalogSum / s.catalogCount);
  const differencePercent =
    s.catalogCount === 0 || s.catalogSum <= 0
      ? null
      : round(((s.catalogPricedNet - s.catalogSum) / s.catalogSum) * 100, 1);
  return {
    catalogItemId: s.catalogItemId,
    code: s.code,
    label: s.label,
    category: s.category,
    ...base,
    catalogAverage,
    catalogCount: s.catalogCount,
    differencePercent,
  };
}

/** Suma filas en la misma moneda (los importes ya vienen redondeados). */
function accumulate<K>(
  rows: readonly ProcedureRow[],
  keyOf: (row: ProcedureRow) => K,
): Map<K, { count: number; gross: number; discounts: number }> {
  const out = new Map<K, { count: number; gross: number; discounts: number }>();
  for (const row of rows) {
    const k = keyOf(row);
    const acc = out.get(k) ?? { count: 0, gross: 0, discounts: 0 };
    acc.count += row.count;
    acc.gross = money(acc.gross + row.gross);
    acc.discounts = money(acc.discounts + row.discounts);
    out.set(k, acc);
  }
  return out;
}

export function buildProcedureProduction(
  sums: readonly ProcedureSums[],
): ProcedureProduction {
  const rows = sums
    .filter((s) => s.count > 0)
    .map(rowOf)
    .sort(
      (a, b) =>
        compareCategory(a.category, b.category) ||
        compareText(a.code, b.code) ||
        a.catalogItemId.localeCompare(b.catalogItemId) ||
        a.currency.localeCompare(b.currency),
    );

  const byCategory = accumulate(rows, (r) =>
    JSON.stringify([r.category, r.currency]),
  );
  const categoryTotals: CategoryTotals[] = [...byCategory.entries()].map(
    ([k, acc]) => {
      const [category, currency] = JSON.parse(k) as [string | null, string];
      return {
        category,
        ...totalsOf(currency, acc.count, acc.gross, acc.discounts),
      };
    },
  );
  categoryTotals.sort(
    (a, b) =>
      compareCategory(a.category, b.category) ||
      a.currency.localeCompare(b.currency),
  );

  const byCurrency = accumulate(rows, (r) => r.currency);
  const totals = [...byCurrency.entries()]
    .map(([currency, acc]) =>
      totalsOf(currency, acc.count, acc.gross, acc.discounts),
    )
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return { rows, categoryTotals, totals };
}
