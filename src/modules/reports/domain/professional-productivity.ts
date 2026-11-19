/*
 * «Profesionales» (DX-304): la productividad de cada profesional en un
 * período. Una fila por profesional con lo que la base de datos suma para él:
 *  - producción atribuible (DX-050): Σ precio neto de los ítems que REALIZÓ,
 *    por moneda del plan, y cuántos;
 *  - cobrado atribuible: Σ de lo imputado (DX-051) a esos ítems por abonos
 *    vivos del período, por moneda del plan;
 *  - citas atendidas, no asistió y cancelaciones tardías (DX-279) de su
 *    agenda, con el no-show % de `kpi-definitions` (la misma fórmula).
 * Los importes NUNCA se suman entre monedas: el total es por moneda.
 */

import { fromCents, toCents } from '../../../shared/money/money';
import {
  KPI_DEFINITIONS,
  noShowRateOf,
  type KpiDefinition,
} from './kpi-definitions';

export interface ProducedAmount {
  currency: string;
  /** Ítems realizados. */
  count: number;
  /** Σ (precio − descuento). */
  net: number;
}

export interface CollectedAmount {
  currency: string;
  amount: number;
}

/** Lo que suma la base de datos para un profesional. */
export interface ProfessionalSums {
  professionalId: string;
  /** null = usuario sin nombre legible (no debería pasar). */
  fullName: string | null;
  production: readonly ProducedAmount[];
  collected: readonly CollectedAmount[];
  completed: number;
  noShow: number;
  lateCancellations: number;
}

export interface ProductivityFigures {
  production: ProducedAmount[];
  collected: CollectedAmount[];
  completedAppointments: number;
  noShows: number;
  lateCancellations: number;
  /** % con 2 decimales; null sin citas que cuenten. */
  noShowRate: number | null;
}

export interface ProductivityRow extends ProductivityFigures {
  professionalId: string;
  fullName: string;
}

export const UNNAMED_PROFESSIONAL = 'Profesional sin nombre';

const byCurrency = <T extends { currency: string }>(list: T[]): T[] =>
  list.sort((a, b) => a.currency.localeCompare(b.currency));

/** Suma exacta en centavos por moneda. */
function sumProduced(lists: readonly (readonly ProducedAmount[])[]) {
  const acc = new Map<string, { count: number; cents: number }>();
  for (const list of lists) {
    for (const p of list) {
      const cur = acc.get(p.currency) ?? { count: 0, cents: 0 };
      cur.count += p.count;
      cur.cents += toCents(p.net);
      acc.set(p.currency, cur);
    }
  }
  return byCurrency(
    [...acc].map(([currency, v]) => ({
      currency,
      count: v.count,
      net: fromCents(v.cents),
    })),
  );
}

function sumCollected(lists: readonly (readonly CollectedAmount[])[]) {
  const acc = new Map<string, number>();
  for (const list of lists) {
    for (const c of list) {
      acc.set(c.currency, (acc.get(c.currency) ?? 0) + toCents(c.amount));
    }
  }
  return byCurrency(
    [...acc].map(([currency, cents]) => ({
      currency,
      amount: fromCents(cents),
    })),
  );
}

function figuresOf(
  production: readonly (readonly ProducedAmount[])[],
  collected: readonly (readonly CollectedAmount[])[],
  counts: { completed: number; noShow: number; lateCancellations: number },
): ProductivityFigures {
  return {
    production: sumProduced(production),
    collected: sumCollected(collected),
    completedAppointments: counts.completed,
    noShows: counts.noShow,
    lateCancellations: counts.lateCancellations,
    noShowRate: noShowRateOf(counts),
  };
}

/**
 * Filas (por nombre) y totales. Un profesional sin nada en el período no
 * llega aquí (la consulta solo devuelve a quien tiene algo).
 */
export function buildProductivity(sums: readonly ProfessionalSums[]): {
  rows: ProductivityRow[];
  totals: ProductivityFigures;
} {
  const rows = sums
    .map((s) => ({
      professionalId: s.professionalId,
      fullName: s.fullName?.trim() || UNNAMED_PROFESSIONAL,
      ...figuresOf([s.production], [s.collected], s),
    }))
    .sort(
      (a, b) =>
        a.fullName.localeCompare(b.fullName, 'es', { sensitivity: 'base' }) ||
        a.professionalId.localeCompare(b.professionalId),
    );
  const totals = figuresOf(
    sums.map((s) => s.production),
    sums.map((s) => s.collected),
    {
      completed: sums.reduce((n, s) => n + s.completed, 0),
      noShow: sums.reduce((n, s) => n + s.noShow, 0),
      lateCancellations: sums.reduce((n, s) => n + s.lateCancellations, 0),
    },
  );
  return { rows, totals };
}

export const PRODUCTIVITY_KPI_KEYS = [
  'production',
  'collected',
  'completedAppointments',
  'noShowRate',
] as const;

export type ProductivityKpiKey = (typeof PRODUCTIVITY_KPI_KEYS)[number];

const DAYS = 'Los días son civiles en la zona horaria de cada sede (DX-097).';

/**
 * «Cómo se calcula» de cada columna. El no-show % y las citas atendidas son
 * los de `KPI_DEFINITIONS` (misma regla que «Comparar sedes»), acotados al
 * profesional de la cita; producción y cobrado, los atribuibles a quien
 * realizó el ítem.
 */
export const PRODUCTIVITY_DEFINITIONS: Readonly<
  Record<ProductivityKpiKey, KpiDefinition>
> = {
  production: {
    ...KPI_DEFINITIONS.production,
    howItIsCalculated:
      'Suma del precio neto (precio − descuento) de los procedimientos que el profesional marcó como realizados en el período, en la sede donde se realizaron y en la moneda de su plan, sin convertir. Los realizados sin registrar quién y dónde («Sin atribuir», DX-050) no cuentan para nadie. ' +
      DAYS,
  },
  collected: {
    ...KPI_DEFINITIONS.collected,
    howItIsCalculated:
      'Lo imputado a los procedimientos realizados por el profesional desde los abonos no anulados con fecha de pago en el período (en la moneda del plan, sin convertir). Lo cobrado sin imputar a ningún procedimiento no es de nadie: está en «Cobrado sin imputar». El día del abono se corta en la zona de la sede donde se realizó el procedimiento.',
  },
  completedAppointments: {
    ...KPI_DEFINITIONS.completedAppointments,
    howItIsCalculated:
      'Citas del profesional en estado «Atendida» cuyo inicio cae en el período, en las sedes que ves. ' +
      DAYS,
  },
  noShowRate: {
    ...KPI_DEFINITIONS.noShowRate,
    howItIsCalculated: `${KPI_DEFINITIONS.noShowRate.howItIsCalculated} Cuentan las citas de la agenda del profesional.`,
  },
};
