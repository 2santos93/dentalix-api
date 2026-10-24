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

/**
 * En qué se mide la variación frente al período comparado: los indicadores
 * que ya son un porcentaje (% de cobro, no-show %, ocupación %) varían en
 * PUNTOS (8 % → 10 % = +2 p.p.); el resto, en % relativo (10 → 12 = +20 %).
 */
export type KpiChangeUnit = 'PERCENT' | 'POINTS';

/** Lectura de la variación según la dirección del indicador. */
export type KpiTrend = 'BETTER' | 'WORSE' | 'EQUAL';

export interface KpiDefinition {
  key: KpiKey;
  label: string;
  unit: KpiUnit;
  /** `true` = un valor por moneda (nunca se mezclan monedas). */
  perCurrency: boolean;
  direction: KpiDirection;
  /** Unidad de la variación: % relativo o puntos porcentuales. */
  changeUnit: KpiChangeUnit;
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
    changeUnit: 'PERCENT',
    howItIsCalculated:
      'Suma del precio neto (precio − descuento) de los procedimientos marcados como realizados en el período, en la sede donde se realizaron y en la moneda de su plan. Los realizados antes de registrar quién y dónde («Sin atribuir») no cuentan. ' +
      'Si el período comparado empieza antes de que se registrara dónde se realiza cada procedimiento (DX-050) y la clínica tiene realizados «Sin atribuir», o si tuvo cobros en esa moneda sin producción atribuida, no se muestra la variación: compararía contra una producción incompleta. ' +
      DAYS,
  },
  collected: {
    key: 'collected',
    label: 'Cobrado',
    unit: 'MONEY',
    perCurrency: true,
    direction: 'HIGHER_IS_BETTER',
    changeUnit: 'PERCENT',
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
    changeUnit: 'POINTS',
    howItIsCalculated:
      'Cobrado ÷ producción del mismo período y moneda, en %. Sin producción en esa moneda no se calcula. Puede pasar del 100 % si se cobró trabajo de otros períodos. ' +
      'Si el período comparado empieza antes de que se registrara dónde se realiza cada procedimiento (DX-050) y la clínica tiene realizados «Sin atribuir», o si tuvo cobros en esa moneda sin producción atribuida, no se muestra la variación: compararía contra una producción incompleta.',
  },
  completedAppointments: {
    key: 'completedAppointments',
    label: 'Citas atendidas',
    unit: 'COUNT',
    perCurrency: false,
    direction: 'HIGHER_IS_BETTER',
    changeUnit: 'PERCENT',
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
    changeUnit: 'POINTS',
    howItIsCalculated:
      'Citas «No asistió» ÷ (atendidas + no asistió + cancelaciones tardías) cuyo inicio cae en el período, en %. Las cancelaciones tardías son las que no respetaron el aviso de la política de la sede (DX-279); las canceladas a tiempo no cuentan. La variación va en puntos. Mejora al bajar.',
  },
  newPatients: {
    key: 'newPatients',
    label: 'Pacientes nuevos',
    unit: 'COUNT',
    perCurrency: false,
    direction: 'HIGHER_IS_BETTER',
    changeUnit: 'PERCENT',
    howItIsCalculated:
      'Pacientes cuya PRIMERA cita atendida en la clínica (en cualquier sede) cae en el período. Cuentan en la sede de esa cita.',
  },
  averageTicket: {
    key: 'averageTicket',
    label: 'Ticket medio',
    unit: 'MONEY',
    perCurrency: true,
    direction: 'HIGHER_IS_BETTER',
    changeUnit: 'PERCENT',
    howItIsCalculated:
      'Cobrado ÷ pacientes distintos con alguna cita atendida en el período, por moneda. En el total, cada paciente cuenta una vez aunque fuera a varias sedes.',
  },
  occupancy: {
    key: 'occupancy',
    label: 'Ocupación %',
    unit: 'PERCENT',
    perCurrency: false,
    direction: 'HIGHER_IS_BETTER',
    changeUnit: 'POINTS',
    howItIsCalculated:
      'Minutos de citas atendidas por los profesionales con horario en la sede ÷ la capacidad de la sede: la suma de los minutos del horario de cada uno de esos profesionales en ella (con sus excepciones por fecha), descontando sus bloqueos y los cierres de toda la sede. Dos profesionales en paralelo son el doble de capacidad que uno; uno de media jornada, la mitad. Nunca pasa del 100 %. Una sede sin profesionales con horario no tiene ocupación (ni cuenta en la del total). ' +
      DAYS,
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
  /** Citas canceladas tarde según la política de la sede (DX-279). */
  lateCancellations: number;
  /** Pacientes distintos con alguna cita COMPLETED. */
  attendedPatients: number;
  newPatients: number;
  /**
   * Minutos de las citas COMPLETED de los profesionales con horario en la
   * sede (DX-233): los mismos cuya capacidad suma `capacityMinutes`.
   */
  completedMinutes: number;
  /**
   * Capacidad (BE-042): Σ minutos del horario de cada profesional en la sede,
   * menos sus bloqueos y los cierres de la sede. `null` = nadie tiene horario
   * en la sede.
   */
  capacityMinutes: number | null;
}

export const EMPTY_AGGREGATES: PeriodAggregates = {
  production: new Map(),
  collected: new Map(),
  completed: 0,
  noShow: 0,
  lateCancellations: 0,
  attendedPatients: 0,
  newPatients: 0,
  completedMinutes: 0,
  capacityMinutes: null,
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

/** Tope de la ocupación: una cita fuera de horario no la lleva más allá. */
const MAX_OCCUPANCY = 100;

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
    noShowRate: percent(a.noShow, a.completed + a.noShow + a.lateCancellations),
    newPatients: a.newPatients,
    averageTicket: currencies.map((currency) => ({
      currency,
      value:
        a.attendedPatients > 0
          ? round((a.collected.get(currency) ?? 0) / a.attendedPatients, 2)
          : null,
    })),
    occupancy:
      a.capacityMinutes !== null && a.capacityMinutes > 0
        ? Math.min(
            MAX_OCCUPANCY,
            percent(a.completedMinutes, a.capacityMinutes) ?? 0,
          )
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
 * cuenta las sedes con profesionales con horario: minutos atendidos y
 * capacidad de las mismas.
 */
export function combineAggregates(
  list: readonly PeriodAggregates[],
  attendedPatients: number,
): PeriodAggregates {
  const scheduled = list.filter((a) => a.capacityMinutes !== null);
  return {
    production: sumByCurrency(list.map((a) => a.production)),
    collected: sumByCurrency(list.map((a) => a.collected)),
    completed: list.reduce((s, a) => s + a.completed, 0),
    noShow: list.reduce((s, a) => s + a.noShow, 0),
    lateCancellations: list.reduce((s, a) => s + a.lateCancellations, 0),
    attendedPatients,
    newPatients: list.reduce((s, a) => s + a.newPatients, 0),
    completedMinutes: scheduled.reduce((s, a) => s + a.completedMinutes, 0),
    capacityMinutes:
      scheduled.length > 0
        ? scheduled.reduce((s, a) => s + (a.capacityMinutes ?? 0), 0)
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

/**
 * Diferencia en puntos porcentuales, con 1 decimal: actual − anterior. Un
 * anterior de 0 % sí es base (0 % → 5 % = +5 p.p.).
 */
export function changePoints(
  current: number | null,
  previous: number | null,
): number | null {
  if (current === null || previous === null) return null;
  return round(current - previous, 1);
}

/** La variación del indicador en su unidad (`changeUnit`). */
export function changeOf(
  key: KpiKey,
  current: number | null,
  previous: number | null,
): number | null {
  return KPI_DEFINITIONS[key].changeUnit === 'POINTS'
    ? changePoints(current, previous)
    : changePercent(current, previous);
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

/**
 * Indicadores que dependen de la producción atribuida (DX-050): con un período
 * comparado sin ella, su variación no se calcula (BE-045).
 */
export const ATTRIBUTION_SENSITIVE_KPIS = [
  'production',
  'collectionRate',
] as const satisfies readonly KpiKey[];

/**
 * Monedas en las que el período tuvo cobros y ninguna producción atribuida:
 * lo cobrado es trabajo que no cuenta (anterior a DX-050 o de otro período) y
 * una producción de 0 no es base para comparar.
 */
export function currenciesCollectedWithoutProduction(
  a: PeriodAggregates,
): Set<string> {
  const out = new Set<string>();
  for (const [currency, collected] of a.collected) {
    if (collected > 0 && (a.production.get(currency) ?? 0) === 0) {
      out.add(currency);
    }
  }
  return out;
}
