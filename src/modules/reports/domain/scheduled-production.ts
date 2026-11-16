/*
 * «Producción agendada y previsión del mes» (DX-567): cuánto vale lo que hay en
 * la agenda (por día y por profesional), qué citas no tienen tratamiento
 * ligado y, para el mes en curso, producido hasta hoy + agendado pendiente =
 * previsión. ÚNICA definición de cada cifra: la API la publica tal cual y la
 * web pinta «Cómo se calcula» con ella.
 *
 * Puro: lo prueban los unit; el repositorio solo cuenta y suma en la BD por
 * (día civil, profesional, sede, moneda) y la aplicación convierte con la tasa
 * GUARDADA del día (nunca el proveedor externo), una vez por día y moneda.
 */

import { round2 } from '../../../shared/money/money';
import {
  addCivilDays,
  civilDaysInclusive,
} from '../../../shared/time/civil-day';
import { BASE_CURRENCY } from '../../exchange/domain/exchange-rate-source';

/** Avisos de la respuesta. */
export const SCHEDULED_PRODUCTION_WARNINGS = [
  'NO_CATALOG_CURRENCY',
  'WITHOUT_RATE',
  'MIXED_MONTHS',
  'UNATTRIBUTED_DONE',
] as const;
export type ScheduledProductionWarning =
  (typeof SCHEDULED_PRODUCTION_WARNINGS)[number];

export const SCHEDULED_PRODUCTION_DEFINITION_KEYS = [
  'SCHEDULED',
  'WITHOUT_ITEMS',
  'PRODUCED_TO_DATE',
  'SCHEDULED_PENDING',
  'FORECAST',
  'WITHOUT_RATE',
] as const;
export type ScheduledProductionDefinitionKey =
  (typeof SCHEDULED_PRODUCTION_DEFINITION_KEYS)[number];

export interface ScheduledProductionDefinition {
  key: ScheduledProductionDefinitionKey;
  /** Nombre corto: el de la columna, la tarjeta o el bloque. */
  label: string;
  /** Las reglas, una por línea («Cómo se calcula»). */
  howItIsCalculated: string[];
}

/** La fórmula de la previsión, literal (la web la enseña tal cual). */
export const FORECAST_FORMULA =
  'Previsión = Producido hasta hoy + Agendado pendiente';

export const SCHEDULED_PRODUCTION_DEFINITIONS: Readonly<
  Record<ScheduledProductionDefinitionKey, ScheduledProductionDefinition>
> = {
  SCHEDULED: {
    key: 'SCHEDULED',
    label: 'Agendado',
    howItIsCalculated: [
      'La suma de los procedimientos aceptados o ya realizados de un presupuesto que están ligados a las citas del día: precio − descuento, en la moneda del catálogo de la clínica.',
      'Cuentan las citas de cualquier estado salvo las canceladas y las inasistencias (también las ya completadas y las que pasaron sin cerrarse). Cancelar una cita o marcar la inasistencia deja de sumar.',
      'El día es el de la hora de inicio de la cita en la zona horaria de su sede; el profesional, el de la cita.',
      'Un procedimiento ligado a varias citas cuenta una sola vez: en la de inicio más reciente (así, uno que se reagendó sin cerrar la cita anterior cuenta en la nueva).',
    ],
  },
  WITHOUT_ITEMS: {
    key: 'WITHOUT_ITEMS',
    label: 'Sin tratamiento ligado',
    howItIsCalculated: [
      'Citas que cuentan (ni canceladas ni inasistencias) sin ningún procedimiento de un presupuesto ligado: no suman importe y se listan para poder ligarlas.',
    ],
  },
  PRODUCED_TO_DATE: {
    key: 'PRODUCED_TO_DATE',
    label: 'Producido hasta hoy',
    howItIsCalculated: [
      'Los procedimientos marcados como realizados desde el día 1 del mes en curso hasta hoy, incluido hoy, en la sede donde se realizaron (cada sede con su zona horaria y su mes).',
      'El profesional es quien lo realizó. Los realizados sin sede o sin fecha (anteriores al registro de quién, dónde y cuándo) no entran y se avisan aparte.',
    ],
  },
  SCHEDULED_PENDING: {
    key: 'SCHEDULED_PENDING',
    label: 'Agendado pendiente',
    howItIsCalculated: [
      'Los procedimientos aceptados que aún no se han realizado, ligados a citas de hoy hasta el último día del mes en curso de su sede.',
      'Lo ya realizado hoy está en «Producido hasta hoy»: no se cuenta dos veces.',
    ],
  },
  FORECAST: {
    key: 'FORECAST',
    label: 'Previsión del mes',
    howItIsCalculated: [
      `${FORECAST_FORMULA}.`,
      'Siempre del mes en curso, con los mismos filtros de sede y profesional (no depende de las fechas elegidas). No resta las inasistencias que puedan llegar.',
    ],
  },
  WITHOUT_RATE: {
    key: 'WITHOUT_RATE',
    label: 'Sin tasa',
    howItIsCalculated: [
      'Un presupuesto en otra moneda se convierte con la tasa guardada del día: el de la cita (o la de hoy, si la cita es futura) o, en lo producido, el día en que se realizó.',
      'Si ese día no hay tasa guardada, ese importe queda fuera de las sumas (las citas siguen contando) y se avisa.',
    ],
  },
};

/** Las definiciones en el orden de publicación. */
export const SCHEDULED_PRODUCTION_DEFINITION_LIST: readonly ScheduledProductionDefinition[] =
  SCHEDULED_PRODUCTION_DEFINITION_KEYS.map(
    (key) => SCHEDULED_PRODUCTION_DEFINITIONS[key],
  );

/** Un importe sumado sin redondear, a 2 decimales; null si no hay importes. */
export function amountOf(value: number | null): number | null {
  return value === null ? null : round2(value);
}

/** Todos los días civiles de `from` a `to` (ambos inclusive), en orden. */
export function civilDaysOf(from: string, to: string): string[] {
  const days = civilDaysInclusive(from, to);
  return Array.from({ length: Math.max(days, 0) }, (_, n) =>
    addCivilDays(from, n),
  );
}

/** El mes (AAAA-MM) de un día civil. */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

/** El primer y el último día del mes del día civil `day`. */
export function monthBounds(day: string): { first: string; last: string } {
  const first = `${monthOf(day)}-01`;
  const [y, m] = first.split('-').map(Number);
  // Día 0 del mes siguiente = último día de este (UTC: sin zona).
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first, last: `${monthOf(day)}-${String(last).padStart(2, '0')}` };
}

/**
 * El día de la tasa con que se convierte lo agendado un día: el de la cita;
 * si aún no ha llegado (no tiene tasa guardada), la de hoy.
 */
export function rateDayFor(day: string, today: string): string {
  return day > today ? today : day;
}

/** Unidades de cada moneda por 1 USD guardadas un día (sin USD). */
export type StoredRates = Readonly<Record<string, number>>;

/**
 * `amount` de `currency` en la moneda del catálogo, SIN redondear (se redondea
 * al final de cada suma). Igual moneda: tal cual. Sin tasa de alguna de las
 * dos: null (fuera de los importes).
 */
export function toCatalogAmount(
  amount: number,
  currency: string,
  catalog: string,
  rates: StoredRates | null,
): number | null {
  if (currency === catalog) return amount;
  if (rates === null) return null;
  const perBase = (code: string): number | undefined =>
    code === BASE_CURRENCY ? 1 : rates[code];
  const from = perBase(currency);
  const to = perBase(catalog);
  if (from === undefined || to === undefined || from <= 0 || to <= 0) {
    return null;
  }
  return (amount * to) / from;
}

/**
 * Lecturas de la tasa guardada de un día y una moneda, memorizadas en la
 * petición: cada (día, moneda) se lee una sola vez aunque salga en muchos
 * grupos. `fetch` nunca debe llamar al proveedor externo.
 */
export function memoizedDailyRates(
  fetch: (day: string, currency: string) => Promise<StoredRates | null>,
): (day: string, currency: string) => Promise<StoredRates | null> {
  const cache = new Map<string, Promise<StoredRates | null>>();
  return (day, currency) => {
    const key = `${day}|${currency}`;
    let found = cache.get(key);
    if (found === undefined) {
      found = fetch(day, currency);
      cache.set(key, found);
    }
    return found;
  };
}

/** Lo agendado de un (día, profesional, sede, moneda), tal como lo suma la BD. */
export interface ScheduledAmountGroup {
  day: string;
  professionalId: string;
  locationId: string;
  currency: string;
  /** precio − descuento en la moneda del plan, sin redondear. */
  amount: number;
  items: number;
  /** Las citas del grupo (solo si la moneda no es la del catálogo). */
  appointmentIds: readonly string[];
}

/** Las citas de un (día, profesional, sede). */
export interface ScheduledAppointmentGroup {
  day: string;
  professionalId: string;
  locationId: string;
  appointments: number;
  withoutItems: number;
}

/** Lo producido o pendiente de un (día, sede, moneda) del mes en curso. */
export interface ForecastAmountGroup {
  day: string;
  locationId: string;
  currency: string;
  amount: number;
  items: number;
}

/** Una suma ya en la moneda del catálogo, sin redondear. */
export interface ConvertedGroup<G> {
  group: G;
  /** null = sin tasa (o sin moneda de catálogo): fuera de los importes. */
  amount: number | null;
}

/**
 * Convierte cada grupo con la tasa de su día (`rateDay`), leyendo cada (día,
 * moneda) una sola vez. Sin moneda de catálogo, todo null.
 */
export async function convertGroups<
  G extends { currency: string; amount: number },
>(
  groups: readonly G[],
  catalog: string | null,
  rateDay: (group: G) => string,
  ratesOf: (day: string, currency: string) => Promise<StoredRates | null>,
): Promise<ConvertedGroup<G>[]> {
  return Promise.all(
    groups.map(async (group) => {
      if (catalog === null) return { group, amount: null };
      if (group.currency === catalog) return { group, amount: group.amount };
      const rates = await ratesOf(rateDay(group), group.currency);
      return {
        group,
        amount: toCatalogAmount(group.amount, group.currency, catalog, rates),
      };
    }),
  );
}

export interface DayRow {
  date: string;
  scheduledAmount: number | null;
  appointments: number;
  appointmentsWithoutItems: number;
}

export interface ProfessionalRow {
  professionalId: string;
  name: string;
  scheduledAmount: number | null;
  appointments: number;
  appointmentsWithoutItems: number;
}

export interface DayProfessionalRow {
  date: string;
  professionalId: string;
  scheduledAmount: number | null;
  appointments: number;
}

export interface ScheduledView {
  totals: {
    scheduledAmount: number | null;
    appointments: number;
    appointmentsWithoutItems: number;
  };
  byDay: DayRow[];
  byProfessional: ProfessionalRow[];
  byDayAndProfessional: DayProfessionalRow[];
  withoutRate: { appointments: number; items: number };
}

/** Nombre de un profesional que ya no consta (usuario sin nombre). */
export const UNKNOWN_PROFESSIONAL_NAME = 'Profesional sin nombre';

/**
 * Las cifras de lo agendado: total, por día (TODOS los días del período, en
 * orden, también con 0), por profesional (por importe desc, luego nombre) y
 * por día y profesional (los que tienen citas). `withAmounts = false` (sin
 * moneda de catálogo): todos los importes null.
 */
export function buildScheduledView(input: {
  days: readonly string[];
  amounts: readonly ConvertedGroup<ScheduledAmountGroup>[];
  appointments: readonly ScheduledAppointmentGroup[];
  names: ReadonlyMap<string, string>;
  withAmounts: boolean;
}): ScheduledView {
  const money = (value: number): number | null =>
    input.withAmounts ? round2(value) : null;
  const sum = new Map<string, number>();
  const add = (key: string, value: number) =>
    sum.set(key, (sum.get(key) ?? 0) + value);
  const withoutRateIds = new Set<string>();
  let withoutRateItems = 0;
  let total = 0;
  for (const { group, amount } of input.amounts) {
    if (amount === null) {
      if (input.withAmounts) {
        withoutRateItems += group.items;
        for (const id of group.appointmentIds) withoutRateIds.add(id);
      }
      continue;
    }
    total += amount;
    add(`d|${group.day}`, amount);
    add(`p|${group.professionalId}`, amount);
    add(`dp|${group.day}|${group.professionalId}`, amount);
  }
  const count = new Map<string, { appointments: number; without: number }>();
  const addCount = (key: string, g: ScheduledAppointmentGroup) => {
    const c = count.get(key) ?? { appointments: 0, without: 0 };
    c.appointments += g.appointments;
    c.without += g.withoutItems;
    count.set(key, c);
  };
  const professionals = new Set<string>();
  const pairs = new Set<string>();
  let appointments = 0;
  let without = 0;
  for (const g of input.appointments) {
    appointments += g.appointments;
    without += g.withoutItems;
    addCount(`d|${g.day}`, g);
    addCount(`p|${g.professionalId}`, g);
    addCount(`dp|${g.day}|${g.professionalId}`, g);
    professionals.add(g.professionalId);
    pairs.add(`${g.day}|${g.professionalId}`);
  }
  const nameOf = (id: string) =>
    input.names.get(id) ?? UNKNOWN_PROFESSIONAL_NAME;
  return {
    totals: {
      scheduledAmount: money(total),
      appointments,
      appointmentsWithoutItems: without,
    },
    byDay: input.days.map((date) => ({
      date,
      scheduledAmount: money(sum.get(`d|${date}`) ?? 0),
      appointments: count.get(`d|${date}`)?.appointments ?? 0,
      appointmentsWithoutItems: count.get(`d|${date}`)?.without ?? 0,
    })),
    byProfessional: [...professionals]
      .map((professionalId) => ({
        professionalId,
        name: nameOf(professionalId),
        scheduledAmount: money(sum.get(`p|${professionalId}`) ?? 0),
        appointments: count.get(`p|${professionalId}`)?.appointments ?? 0,
        appointmentsWithoutItems:
          count.get(`p|${professionalId}`)?.without ?? 0,
      }))
      .sort(
        (a, b) =>
          (b.scheduledAmount ?? 0) - (a.scheduledAmount ?? 0) ||
          b.appointments - a.appointments ||
          a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }) ||
          a.professionalId.localeCompare(b.professionalId),
      ),
    byDayAndProfessional: [...pairs]
      .map((pair) => {
        const [date, professionalId] = pair.split('|');
        return {
          date,
          professionalId,
          scheduledAmount: money(sum.get(`dp|${pair}`) ?? 0),
          appointments: count.get(`dp|${pair}`)?.appointments ?? 0,
        };
      })
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          nameOf(a.professionalId).localeCompare(
            nameOf(b.professionalId),
            'es',
            { sensitivity: 'base' },
          ) ||
          a.professionalId.localeCompare(b.professionalId),
      ),
    withoutRate: {
      appointments: withoutRateIds.size,
      items: withoutRateItems,
    },
  };
}

export interface ForecastView {
  /** Mes en curso (AAAA-MM) de la sede de referencia. */
  month: string;
  /** Hoy (AAAA-MM-DD) en la sede de referencia. */
  today: string;
  producedToDate: number | null;
  scheduledPending: number | null;
  /** producedToDate + scheduledPending (de los dos ya redondeados). */
  forecast: number | null;
  /** Procedimientos (realizados o pendientes) fuera de los importes por falta de tasa. */
  itemsWithoutRate: number;
}

/**
 * La previsión del mes: los dos sumandos (cada uno redondeado una vez) y su
 * suma, que cuadra con lo que se ve. Sin moneda de catálogo, todo null.
 */
export function buildForecast(input: {
  month: string;
  today: string;
  produced: readonly ConvertedGroup<ForecastAmountGroup>[];
  pending: readonly ConvertedGroup<ForecastAmountGroup>[];
  withAmounts: boolean;
}): ForecastView {
  let itemsWithoutRate = 0;
  const total = (rows: readonly ConvertedGroup<ForecastAmountGroup>[]) => {
    let value = 0;
    for (const { group, amount } of rows) {
      if (amount === null) itemsWithoutRate += group.items;
      else value += amount;
    }
    return round2(value);
  };
  const produced = total(input.produced);
  const pending = total(input.pending);
  if (!input.withAmounts) {
    return {
      month: input.month,
      today: input.today,
      producedToDate: null,
      scheduledPending: null,
      forecast: null,
      itemsWithoutRate: 0,
    };
  }
  return {
    month: input.month,
    today: input.today,
    producedToDate: produced,
    scheduledPending: pending,
    forecast: round2(produced + pending),
    itemsWithoutRate,
  };
}

/** Los avisos de la respuesta, en el orden del catálogo. */
export function scheduledProductionWarnings(input: {
  currency: string | null;
  withoutRate: number;
  mixedMonths: boolean;
  unattributedDone: number;
}): ScheduledProductionWarning[] {
  const warnings: ScheduledProductionWarning[] = [];
  if (input.currency === null) warnings.push('NO_CATALOG_CURRENCY');
  else if (input.withoutRate > 0) warnings.push('WITHOUT_RATE');
  if (input.mixedMonths) warnings.push('MIXED_MONTHS');
  if (input.unattributedDone > 0) warnings.push('UNATTRIBUTED_DONE');
  return warnings;
}
