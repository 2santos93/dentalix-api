/*
 * «Rentabilidad por sede» (DX-410): ingresos − gastos de cada sede y del
 * grupo en un período, con una de dos BASES. ÚNICA definición de cada base:
 * la API la publica tal cual (la web pinta la cabecera y «Cómo se calcula»
 * con ella) y el CSV escribe la misma, así que la regla cambia en un sitio.
 *
 *  - CAJA (`CASH`): lo que entró y salió. Abonos vivos − pagos de gastos
 *    vivos, por su fecha de pago.
 *  - DEVENGO (`ACCRUAL`): lo que se ganó y se debe. Producción realizada −
 *    gastos no anulados por su fecha de factura, pagados o no.
 *
 * Los importes NUNCA se suman ni se restan entre monedas: cada sede tiene una
 * línea por moneda y el total del grupo suma solo dentro de la misma moneda.
 * Los gastos no tienen tasa congelada (solo los abonos, DX-375), así que
 * convertir mezclaría tasas de días distintos: cada moneda va por separado.
 *
 * Todo se suma en CÉNTIMOS enteros (DX-054) y solo se pasa a unidades al
 * final, para que 0.10 + 0.20 sea 0.30 también en el total del grupo.
 */

import { fromCents } from '../../../shared/money/money';

export const PROFITABILITY_BASES = ['CASH', 'ACCRUAL'] as const;
export type ProfitabilityBasis = (typeof PROFITABILITY_BASES)[number];

export const PROFITABILITY_SIDES = ['INCOME', 'EXPENSE'] as const;
export type ProfitabilitySide = (typeof PROFITABILITY_SIDES)[number];

export interface ProfitabilityDefinition {
  basis: ProfitabilityBasis;
  /** «Caja» / «Devengo»: va en la cabecera del informe y del CSV. */
  label: string;
  /** Qué son los ingresos en esta base. */
  incomeLabel: string;
  /** Qué son los gastos en esta base. */
  expensesLabel: string;
  /** Una frase: la fórmula de la base. */
  formula: string;
  /** Las reglas, una por línea («Cómo se calcula»). */
  howItIsCalculated: string[];
}

const COMMON_RULES = [
  'Laboratorio, insumos y el resto de gastos cuentan una sola vez: como el gasto registrado en su categoría. La producción va a precio neto y no los descuenta.',
  'Cada moneda va por separado y sin convertir: un ingreso en una moneda nunca se resta de un gasto en otra. El total del grupo suma cada moneda por su lado.',
  'Margen = resultado ÷ ingresos de la misma moneda; sin ingresos no hay margen.',
  'Solo las sedes que puedes ver; el total del grupo suma esas sedes. No lleva datos de pacientes.',
];

export const PROFITABILITY_DEFINITIONS: Readonly<
  Record<ProfitabilityBasis, ProfitabilityDefinition>
> = {
  CASH: {
    basis: 'CASH',
    label: 'Caja',
    incomeLabel: 'Cobrado',
    expensesLabel: 'Gastos pagados',
    formula: 'Resultado = cobrado − gastos pagados, por fecha de pago.',
    howItIsCalculated: [
      'Cobrado: los abonos no anulados con fecha de pago en el período, en la sede que los recibió y en su moneda. Los días son civiles en la zona horaria de cada sede.',
      'Gastos pagados: los pagos de gastos no anulados con fecha de pago en el período, en la sede del gasto, repartidos por la categoría del gasto. Un gasto aún sin pagar no cuenta.',
      ...COMMON_RULES,
    ],
  },
  ACCRUAL: {
    basis: 'ACCRUAL',
    label: 'Devengo',
    incomeLabel: 'Producción realizada',
    expensesLabel: 'Gastos facturados',
    formula:
      'Resultado = producción realizada − gastos por fecha de factura, pagados o no.',
    howItIsCalculated: [
      'Producción realizada: el precio neto (precio − descuento) de los procedimientos marcados como realizados en el período, en la sede donde se realizaron y en la moneda de su plan. Los realizados «Sin atribuir» a una sede no cuentan. Los días son civiles en la zona horaria de cada sede.',
      'Gastos facturados: los gastos no anulados con fecha de factura en el período, pagados o no, en su sede y repartidos por categoría.',
      ...COMMON_RULES,
    ],
  },
};

export const GROUP_TOTAL_NAME = 'Total del grupo';

/** Una suma que hace la base de datos, en céntimos enteros. */
export interface IncomeSum {
  locationId: string;
  currency: string;
  cents: number;
  count: number;
}

export interface ExpenseSum extends IncomeSum {
  /** La foto del nombre de la categoría del gasto. */
  category: string;
}

export interface ProfitabilityLocation {
  id: string;
  name: string;
  isActive: boolean;
  timeZone: string;
}

export interface ProfitabilityCategoryView {
  category: string;
  amount: number;
  /** Pagos de gastos (caja) o gastos (devengo) que la forman. */
  count: number;
}

/** Una moneda de una sede (o del grupo). */
export interface ProfitabilityCurrencyView {
  currency: string;
  income: number;
  /** Abonos (caja) o procedimientos realizados (devengo) que lo forman. */
  incomeCount: number;
  expenses: number;
  expenseCount: number;
  /** Ingresos − gastos; puede ser negativo. */
  net: number;
  /** Resultado ÷ ingresos en %, 1 decimal; null sin ingresos. */
  margin: number | null;
  /** Mayor primero; empate por nombre. */
  categories: ProfitabilityCategoryView[];
}

export interface ProfitabilityRowView {
  /** null = el total del grupo. */
  locationId: string | null;
  name: string;
  isActive: boolean;
  /** Zona de la sede; null en el total, que mezcla las de cada sede. */
  timeZone: string | null;
  /** Por moneda, en orden alfabético; vacío = sin movimientos. */
  currencies: ProfitabilityCurrencyView[];
}

interface Bucket {
  incomeCents: number;
  incomeCount: number;
  categories: Map<string, { cents: number; count: number }>;
}

function emptyBucket(): Bucket {
  return { incomeCents: 0, incomeCount: 0, categories: new Map() };
}

/** Margen en % con 1 decimal, o null sin ingresos positivos. */
export function marginPercent(
  netCents: number,
  incomeCents: number,
): number | null {
  if (incomeCents <= 0) return null;
  return Math.round((netCents / incomeCents) * 1000) / 10;
}

function currencyView(currency: string, b: Bucket): ProfitabilityCurrencyView {
  const categories = [...b.categories]
    .sort(([a, x], [c, y]) => y.cents - x.cents || a.localeCompare(c, 'es'))
    .map(([category, s]) => ({
      category,
      amount: fromCents(s.cents),
      count: s.count,
    }));
  const expenseCents = [...b.categories.values()].reduce(
    (s, c) => s + c.cents,
    0,
  );
  const expenseCount = [...b.categories.values()].reduce(
    (s, c) => s + c.count,
    0,
  );
  const netCents = b.incomeCents - expenseCents;
  return {
    currency,
    income: fromCents(b.incomeCents),
    incomeCount: b.incomeCount,
    expenses: fromCents(expenseCents),
    expenseCount,
    net: fromCents(netCents),
    margin: marginPercent(netCents, b.incomeCents),
    categories,
  };
}

function viewsOf(buckets: Map<string, Bucket>): ProfitabilityCurrencyView[] {
  return [...buckets]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, b]) => currencyView(currency, b));
}

/**
 * Las filas del informe a partir de las sumas: una por sede (en el orden de
 * `locations`, también las que no tuvieron movimientos) y el total del grupo,
 * que suma las de esas sedes moneda a moneda. Una suma de una sede que no
 * está en `locations` se ignora (no entra ni en el total).
 */
export function buildProfitabilityRows(
  locations: readonly ProfitabilityLocation[],
  income: readonly IncomeSum[],
  expenses: readonly ExpenseSum[],
): { locations: ProfitabilityRowView[]; total: ProfitabilityRowView } {
  const byLocation = new Map(
    locations.map((l) => [l.id, new Map<string, Bucket>()]),
  );
  const total = new Map<string, Bucket>();
  const bucketsOf = (map: Map<string, Bucket>, currency: string): Bucket => {
    let bucket = map.get(currency);
    if (!bucket) {
      bucket = emptyBucket();
      map.set(currency, bucket);
    }
    return bucket;
  };
  for (const s of income) {
    const location = byLocation.get(s.locationId);
    if (!location) continue;
    for (const b of [
      bucketsOf(location, s.currency),
      bucketsOf(total, s.currency),
    ]) {
      b.incomeCents += s.cents;
      b.incomeCount += s.count;
    }
  }
  for (const s of expenses) {
    const location = byLocation.get(s.locationId);
    if (!location) continue;
    for (const b of [
      bucketsOf(location, s.currency),
      bucketsOf(total, s.currency),
    ]) {
      const c = b.categories.get(s.category) ?? { cents: 0, count: 0 };
      b.categories.set(s.category, {
        cents: c.cents + s.cents,
        count: c.count + s.count,
      });
    }
  }
  return {
    locations: locations.map((l) => ({
      locationId: l.id,
      name: l.name,
      isActive: l.isActive,
      timeZone: l.timeZone,
      currencies: viewsOf(byLocation.get(l.id) ?? new Map<string, Bucket>()),
    })),
    total: {
      locationId: null,
      name: GROUP_TOTAL_NAME,
      isActive: true,
      timeZone: null,
      currencies: viewsOf(total),
    },
  };
}

/** Estado de pago de un gasto (devengo) a partir de lo pagado en vivo. */
export type ExpensePaymentStatus = 'PAID' | 'PARTIAL' | 'UNPAID';

export function expensePaymentStatus(
  amountCents: number,
  paidCents: number,
): ExpensePaymentStatus {
  if (paidCents <= 0) return 'UNPAID';
  return paidCents >= amountCents ? 'PAID' : 'PARTIAL';
}
