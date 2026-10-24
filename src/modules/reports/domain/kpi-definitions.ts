/*
 * Indicadores de «Comparar sedes» (DX-014). ÚNICA definición de cada KPI: qué
 * mide, cómo se calcula a partir de las sumas que hace la base de datos, si es
 * por moneda y en qué dirección es «mejor». La API la publica tal cual (la web
 * pinta su tooltip «Cómo se calcula» y el color de la flecha con ella) y el CSV
 * también la usa, así que una regla cambia en un solo sitio.
 *
 * Los importes NUNCA se suman entre monedas: cada indicador de dinero es una
 * lista por moneda, y el «Total clínica» suma solo dentro de la misma moneda.
 */

export const KPI_KEYS = [
  'production',
  'collected',
  'collectionRate',
  'completedAppointments',
  'noShowRate',
  'newPatients',
  'averageTicket',
  'occupancy',
] as const;

export type KpiKey = (typeof KPI_KEYS)[number];

export type KpiUnit = 'MONEY' | 'PERCENT' | 'COUNT';

/** Hacia dónde mejora el indicador: el no-show mejora al bajar. */
export type KpiDirection = 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';

/** Lectura de la variación según la dirección del indicador. */
export type KpiTrend = 'BETTER' | 'WORSE' | 'EQUAL';

export interface KpiDefinition {
  key: KpiKey;
  label: string;
  unit: KpiUnit;
  /** `true` = un valor por moneda (nunca se mezclan monedas). */
  perCurrency: boolean;
  direction: KpiDirection;
  /** Texto del tooltip «Cómo se calcula». */
  howItIsCalculated: string;
}

const DAYS = 'Los días son civiles en la zona horaria de cada sede (DX-097).';

export const KPI_DEFINITIONS: Readonly<Record<KpiKey, KpiDefinition>> = {
  production: {
    key: 'production',
    label: 'Producción',
    unit: 'MONEY',
    perCurrency: true,
    direction: 'HIGHER_IS_BETTER',
    howItIsCalculated:
      'Suma del precio neto (precio − descuento) de los procedimientos marcados como realizados en el período, en la sede donde se realizaron y en la moneda de su plan. Los realizados antes de registrar quién y dónde («Sin atribuir») no cuentan. ' +
      DAYS,
  },
  collected: {
    key: 'collected',
    label: 'Cobrado',
    unit: 'MONEY',
    perCurrency: true,
    direction: 'HIGHER_IS_BETTER',
    howItIsCalculated:
      'Suma de los abonos no anulados con fecha de pago en el período, en la sede que los recibió y en su moneda (sin convertir). ' +
      DAYS,
  },
  collectionRate: {
    key: 'collectionRate',
    label: '% de cobro',
    unit: 'PERCENT',
    perCurrency: true,
    direction: 'HIGHER_IS_BETTER',
    howItIsCalculated:
      'Cobrado ÷ producción del mismo período y moneda, en %. Sin producción en esa moneda no se calcula. Puede pasar del 100 % si se cobró trabajo de otros períodos.',
  },
  completedAppointments: {
    key: 'completedAppointments',
    label: 'Citas atendidas',
    unit: 'COUNT',
    perCurrency: false,
    direction: 'HIGHER_IS_BETTER',
    howItIsCalculated:
      'Citas en estado «Atendida» cuyo inicio cae en el período, en su sede. ' +
      DAYS,
  },
  noShowRate: {
    key: 'noShowRate',
    label: 'No-show %',
    unit: 'PERCENT',
    perCurrency: false,
    direction: 'LOWER_IS_BETTER',
    howItIsCalculated:
      'Citas «No asistió» ÷ (atendidas + no asistió) cuyo inicio cae en el período, en %. Las canceladas no cuentan. Mejora al bajar.',
  },
  newPatients: {
    key: 'newPatients',
    label: 'Pacientes nuevos',
    unit: 'COUNT',
    perCurrency: false,
    direction: 'HIGHER_IS_BETTER',
    howItIsCalculated:
      'Pacientes cuya PRIMERA cita atendida en la clínica (en cualquier sede) cae en el período. Cuentan en la sede de esa cita.',
  },
  averageTicket: {
    key: 'averageTicket',
    label: 'Ticket medio',
    unit: 'MONEY',
    perCurrency: true,
    direction: 'HIGHER_IS_BETTER',
    howItIsCalculated:
      'Cobrado ÷ pacientes distintos con alguna cita atendida en el período, por moneda. En el total, cada paciente cuenta una vez aunque fuera a varias sedes.',
  },
  occupancy: {
    key: 'occupancy',
    label: 'Ocupación %',
    unit: 'PERCENT',
    perCurrency: false,
    direction: 'HIGHER_IS_BETTER',
    howItIsCalculated:
      'Minutos de citas atendidas ÷ minutos abiertos según el horario semanal vigente de la sede, descontando los bloqueos de toda la sede que no admiten citas. Una sede sin horario configurado no tiene ocupación (ni cuenta en la del total).',
  },
};

/**
 * Lo que suma la base de datos para UNA sede (o el total) en UN período. Los
 * indicadores salen de aquí con `computeKpis`.
 */
export interface PeriodAggregates {
  /** Σ precio neto de los ítems realizados, por moneda del plan. */
  production: ReadonlyMap<string, number>;
  /** Σ abonos no anulados, por moneda del abono. */
  collected: ReadonlyMap<string, number>;
  completed: number;
  noShow: number;
  /** Pacientes distintos con alguna cita COMPLETED. */
  attendedPatients: number;
  newPatients: number;
  /** Minutos de las citas COMPLETED. */
  completedMinutes: number;
  /** Minutos abiertos según el horario; `null` = la sede no tiene horario. */
  openMinutes: number | null;
}

export const EMPTY_AGGREGATES: PeriodAggregates = {
  production: new Map(),
  collected: new Map(),
  completed: 0,
  noShow: 0,
  attendedPatients: 0,
  newPatients: 0,
  completedMinutes: 0,
  openMinutes: null,
};

export interface CurrencyValue {
  currency: string;
  value: number | null;
}

export interface KpiValues {
  production: CurrencyValue[];
  collected: CurrencyValue[];
  collectionRate: CurrencyValue[];
  completedAppointments: number;
  noShowRate: number | null;
  newPatients: number;
  averageTicket: CurrencyValue[];
  occupancy: number | null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** `numerator ÷ denominator` en % con 2 decimales; null si no hay base. */
function percent(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round((numerator / denominator) * 100, 2) : null;
}

/**
 * Los ocho indicadores de unas sumas. `currencies` fija qué monedas salen en
 * los de dinero (las del período Y las del anterior, para que una moneda que
 * desaparece se vea como 0 frente a lo que hubo).
 */
export function computeKpis(
  a: PeriodAggregates,
  currencies: readonly string[],
): KpiValues {
  const money = (map: ReadonlyMap<string, number>): CurrencyValue[] =>
    currencies.map((currency) => ({
      currency,
      value: round(map.get(currency) ?? 0, 2),
    }));
  return {
    production: money(a.production),
    collected: money(a.collected),
    collectionRate: currencies.map((currency) => ({
      currency,
      value: percent(
        a.collected.get(currency) ?? 0,
        a.production.get(currency) ?? 0,
      ),
    })),
    completedAppointments: a.completed,
    noShowRate: percent(a.noShow, a.completed + a.noShow),
    newPatients: a.newPatients,
    averageTicket: currencies.map((currency) => ({
      currency,
      value:
        a.attendedPatients > 0
          ? round((a.collected.get(currency) ?? 0) / a.attendedPatients, 2)
          : null,
    })),
    occupancy:
      a.openMinutes !== null && a.openMinutes > 0
        ? percent(a.completedMinutes, a.openMinutes)
        : null,
  };
}

/** Monedas con importe en alguna de las sumas, ordenadas. */
export function currenciesOf(list: readonly PeriodAggregates[]): string[] {
  const codes = new Set<string>();
  for (const a of list) {
    for (const code of a.production.keys()) codes.add(code);
    for (const code of a.collected.keys()) codes.add(code);
  }
  return [...codes].sort();
}

function sumByCurrency(
  maps: readonly ReadonlyMap<string, number>[],
): Map<string, number> {
  const total = new Map<string, number>();
  for (const map of maps) {
    for (const [currency, value] of map) {
      total.set(currency, (total.get(currency) ?? 0) + value);
    }
  }
  return new Map([...total].sort(([x], [y]) => x.localeCompare(y)));
}

/**
 * Sumas del «Total clínica»: por moneda (nunca entre monedas), citas, nuevos y
 * minutos. Los pacientes distintos NO se suman (uno que fue a dos sedes contaría
 * dos veces): los da la base de datos para el conjunto. La ocupación solo
 * cuenta las sedes con horario, minutos atendidos y abiertos de las mismas.
 */
export function combineAggregates(
  list: readonly PeriodAggregates[],
  attendedPatients: number,
): PeriodAggregates {
  const scheduled = list.filter((a) => a.openMinutes !== null);
  return {
    production: sumByCurrency(list.map((a) => a.production)),
    collected: sumByCurrency(list.map((a) => a.collected)),
    completed: list.reduce((s, a) => s + a.completed, 0),
    noShow: list.reduce((s, a) => s + a.noShow, 0),
    attendedPatients,
    newPatients: list.reduce((s, a) => s + a.newPatients, 0),
    completedMinutes: scheduled.reduce((s, a) => s + a.completedMinutes, 0),
    openMinutes:
      scheduled.length > 0
        ? scheduled.reduce((s, a) => s + (a.openMinutes ?? 0), 0)
        : null,
  };
}

/**
 * Variación % del valor frente al anterior, con 1 decimal: (actual − anterior)
 * ÷ |anterior|. Sin anterior (o 0) no hay base: null.
 */
export function changePercent(
  current: number | null,
  previous: number | null,
): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return round(((current - previous) / Math.abs(previous)) * 100, 1);
}

/** Mejora / empeora / igual según la dirección del indicador. */
export function trendOf(
  key: KpiKey,
  current: number | null,
  previous: number | null,
): KpiTrend | null {
  if (current === null || previous === null) return null;
  if (current === previous) return 'EQUAL';
  const up = current > previous;
  const higherIsBetter = KPI_DEFINITIONS[key].direction === 'HIGHER_IS_BETTER';
  return up === higherIsBetter ? 'BETTER' : 'WORSE';
}
