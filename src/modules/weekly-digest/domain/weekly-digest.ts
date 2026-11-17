import { round2 } from '../../../shared/money/money';
import { changePercent } from '../../reports/domain/kpi-definitions';
import type { DigestWeek } from './weekly-digest-schedule';

/**
 * DX-568: el resumen semanal de una clínica, en números (sin formato). Lo
 * arma `composeWeeklyDigest` con lo que devuelven las MISMAS fuentes de
 * Reportes, para que cada cifra coincida con la del informe de la misma
 * semana y sede. Solo recuentos e importes: ningún dato de pacientes.
 */

/** Una fuente que pudo fallar: su fallo marca sus cifras «no disponible». */
export type SourceResult<T> = { ok: true; value: T } | { ok: false };

/** Un importe de esta semana y de la anterior en una moneda. */
export interface CurrencyPair {
  currency: string;
  current: number | null;
  previous: number | null;
  /**
   * BE-045: la producción de la semana anterior no es base (sin atribuir):
   * sin variación, como en Comparar sedes.
   */
  previousUnattributed?: boolean;
}

export interface CountPair {
  current: number | null;
  previous: number | null;
}

/** Lo que el resumen toma de «Comparar sedes» (DX-014) para una fila. */
export interface ComparisonFigures {
  collected: CurrencyPair[];
  production: CurrencyPair[];
  completedAppointments: CountPair;
  /** Recuento de inasistencias (el KPI visible es solo el %). */
  noShows: CountPair;
  /** `noShowRate` del informe (%), tal cual. */
  noShowRate: number | null;
  newPatients: CountPair;
}

export interface QuoteWeekFigures {
  presented: { count: number; amount: number | null };
  accepted: { count: number; amount: number | null };
  /** Presentaciones sin tasa: su importe no suma (DX-558). */
  withoutRate: number;
}

/** Lo que el resumen toma del embudo de presupuestos (DX-558), W y W-1. */
export interface QuoteFigures {
  /** Moneda del catálogo; null = sin importes. */
  currency: string | null;
  current: QuoteWeekFigures;
  previous: QuoteWeekFigures;
}

/** Saldo vencido de hoy por moneda (cartera, DX-145). */
export interface ReceivablesFigures {
  overdue: { currency: string; amount: number }[];
  /** Abonos en otra moneda que no suman por falta de tasa. */
  paymentsWithoutRateCount: number;
  rateProviderTimedOut: boolean;
  /**
   * Los mismos avisos por moneda del plan: la marca va solo en la cifra de
   * esa moneda. Solo las monedas con aviso.
   */
  withoutRateByCurrency: Record<string, { count: number; timedOut: boolean }>;
}

/** Turnos de caja abiertos ahora y cuántos se abrieron antes de hoy. */
export interface CashFigures {
  open: number;
  openBeforeToday: number;
}

/** Las fuentes de una fila (una sede o el total de la clínica). */
export interface DigestScopeSources {
  comparison: SourceResult<ComparisonFigures>;
  quotes: SourceResult<QuoteFigures>;
  receivables: SourceResult<ReceivablesFigures>;
  cash: SourceResult<CashFigures>;
}

export interface DigestLocationSources extends DigestScopeSources {
  locationId: string;
  name: string;
}

export interface DigestSources {
  week: DigestWeek;
  previousWeek: DigestWeek;
  locations: DigestLocationSources[];
  total: DigestScopeSources;
}

/**
 * Foto del saldo vencido al enviar, por sede y moneda (y el total): la base
 * de la variación del resumen de la semana siguiente. Solo las filas cuya
 * cartera se pudo leer.
 */
export interface ReceivablesSnapshot {
  version: 1;
  byLocation: Record<string, Record<string, number>>;
  total: Record<string, number> | null;
}

export const DIGEST_METRIC_KEYS = [
  'collected',
  'production',
  'completedAppointments',
  'noShows',
  'newPatients',
  'quotesPresented',
  'quotesAccepted',
  'overdueBalance',
  'openCashSessions',
] as const;
export type DigestMetricKey = (typeof DIGEST_METRIC_KEYS)[number];

/** Una cifra del resumen (una moneda, si es dinero). */
export interface DigestMetric {
  key: DigestMetricKey;
  /** Moneda del importe; null en los recuentos. */
  currency: string | null;
  /** La fuente falló: la cifra sale «No disponible». */
  unavailable: boolean;
  current: number | null;
  /** La semana anterior (o la foto del envío anterior); null = sin base. */
  previous: number | null;
  /** % de variación (1 decimal) frente a `previous`; null = sin variación. */
  change: number | null;
  /** Presupuestos: el importe (moneda del catálogo) de esta semana y la anterior. */
  amount?: { current: number | null; previous: number | null };
  /** Inasistencias: el % del informe. */
  rate?: number | null;
  /** Cifra incompleta por falta de tasa: cuántos abonos o presentaciones. */
  withoutRate: number;
  /** El proveedor de tasas no respondió (la cartera nunca lo llama aquí). */
  rateProviderTimedOut?: boolean;
  /** Caja: de los abiertos, cuántos se abrieron antes de hoy. */
  openBeforeToday?: number;
}

export interface DigestSection {
  /** null = total de la clínica. */
  locationId: string | null;
  name: string;
  metrics: DigestMetric[];
}

export interface WeeklyDigest {
  week: DigestWeek;
  previousWeek: DigestWeek;
  sections: DigestSection[];
  receivablesSnapshot: ReceivablesSnapshot;
}

export const TOTAL_SECTION_NAME = 'Total de la clínica';

function unavailable(
  key: DigestMetricKey,
  currency: string | null = null,
): DigestMetric {
  return {
    key,
    currency,
    unavailable: true,
    current: null,
    previous: null,
    change: null,
    withoutRate: 0,
  };
}

function count(key: DigestMetricKey, pair: CountPair): DigestMetric {
  return {
    key,
    currency: null,
    unavailable: false,
    current: pair.current,
    previous: pair.previous,
    change: changePercent(pair.current, pair.previous),
    withoutRate: 0,
  };
}

function moneyMetrics(
  key: DigestMetricKey,
  pairs: CurrencyPair[],
): DigestMetric[] {
  // Sin movimientos en ninguna moneda: una fila sin moneda, en cero.
  if (pairs.length === 0) {
    return [
      {
        key,
        currency: null,
        unavailable: false,
        current: 0,
        previous: 0,
        change: 0,
        withoutRate: 0,
      },
    ];
  }
  return pairs.map((pair) => ({
    key,
    currency: pair.currency,
    unavailable: false,
    current: pair.current,
    previous: pair.previous,
    change: pair.previousUnattributed
      ? null
      : changePercent(pair.current, pair.previous),
    withoutRate: 0,
  }));
}

function comparisonMetrics(
  source: SourceResult<ComparisonFigures>,
): DigestMetric[] {
  if (!source.ok) {
    return [
      unavailable('collected'),
      unavailable('production'),
      unavailable('completedAppointments'),
      unavailable('noShows'),
      unavailable('newPatients'),
    ];
  }
  const f = source.value;
  return [
    ...moneyMetrics('collected', f.collected),
    ...moneyMetrics('production', f.production),
    count('completedAppointments', f.completedAppointments),
    { ...count('noShows', f.noShows), rate: f.noShowRate },
    count('newPatients', f.newPatients),
  ];
}

function quoteMetrics(source: SourceResult<QuoteFigures>): DigestMetric[] {
  if (!source.ok) {
    return [unavailable('quotesPresented'), unavailable('quotesAccepted')];
  }
  const { currency, current, previous } = source.value;
  const step = (
    key: DigestMetricKey,
    pick: (w: QuoteWeekFigures) => { count: number; amount: number | null },
  ): DigestMetric => ({
    ...count(key, {
      current: pick(current).count,
      previous: pick(previous).count,
    }),
    currency,
    amount: {
      current: currency === null ? null : pick(current).amount,
      previous: currency === null ? null : pick(previous).amount,
    },
    withoutRate: 0,
  });
  // La marca «sin tasa» va solo en los presentados: los aceptados son parte
  // de ellos y repetirla no añade nada.
  return [
    {
      ...step('quotesPresented', (w) => w.presented),
      withoutRate: current.withoutRate,
    },
    step('quotesAccepted', (w) => w.accepted),
  ];
}

function receivablesMetrics(
  source: SourceResult<ReceivablesFigures>,
  previous: Record<string, number> | null,
): DigestMetric[] {
  if (!source.ok) return [unavailable('overdueBalance')];
  const { overdue, withoutRateByCurrency } = source.value;
  const now = new Map(overdue.map((o) => [o.currency, round2(o.amount)]));
  // Una moneda con aviso de tasa sale aunque no tenga nada vencido: su deuda
  // puede estar sin sumar (o, sin respuesta del proveedor, «por vencer»).
  const currencies = [
    ...new Set([
      ...now.keys(),
      ...Object.keys(previous ?? {}),
      ...Object.keys(withoutRateByCurrency),
    ]),
  ].sort();
  if (currencies.length === 0) {
    return [
      {
        key: 'overdueBalance',
        currency: null,
        unavailable: false,
        current: 0,
        previous: previous === null ? null : 0,
        change: previous === null ? null : 0,
        withoutRate: 0,
      },
    ];
  }
  return currencies.map((currency) => {
    const current = now.get(currency) ?? 0;
    const before = previous === null ? null : (previous[currency] ?? 0);
    const flags = withoutRateByCurrency[currency];
    return {
      key: 'overdueBalance',
      currency,
      unavailable: false,
      current,
      previous: before,
      change: changePercent(current, before),
      withoutRate: flags?.count ?? 0,
      ...(flags?.timedOut ? { rateProviderTimedOut: true } : {}),
    };
  });
}

function cashMetrics(source: SourceResult<CashFigures>): DigestMetric[] {
  if (!source.ok) return [unavailable('openCashSessions')];
  return [
    {
      key: 'openCashSessions',
      currency: null,
      unavailable: false,
      current: source.value.open,
      // Foto de ahora: sin semana anterior ni variación.
      previous: null,
      change: null,
      withoutRate: 0,
      openBeforeToday: source.value.openBeforeToday,
    },
  ];
}

function sectionOf(
  locationId: string | null,
  name: string,
  sources: DigestScopeSources,
  previousOverdue: Record<string, number> | null,
): DigestSection {
  return {
    locationId,
    name,
    metrics: [
      ...comparisonMetrics(sources.comparison),
      ...quoteMetrics(sources.quotes),
      ...receivablesMetrics(sources.receivables, previousOverdue),
      ...cashMetrics(sources.cash),
    ],
  };
}

function overdueMap(source: SourceResult<ReceivablesFigures>) {
  if (!source.ok) return null;
  return Object.fromEntries(
    source.value.overdue.map((o) => [o.currency, round2(o.amount)]),
  );
}

/** La foto del saldo vencido de este envío (base del siguiente). */
export function receivablesSnapshotOf(
  sources: DigestSources,
): ReceivablesSnapshot {
  const byLocation: Record<string, Record<string, number>> = {};
  for (const location of sources.locations) {
    const map = overdueMap(location.receivables);
    if (map) byLocation[location.locationId] = map;
  }
  return {
    version: 1,
    byLocation,
    total: overdueMap(sources.total.receivables),
  };
}

/** Lee la foto guardada en el envío anterior; algo irreconocible = sin base. */
export function readReceivablesSnapshot(
  value: unknown,
): ReceivablesSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<ReceivablesSnapshot>;
  if (v.version !== 1 || typeof v.byLocation !== 'object' || !v.byLocation) {
    return null;
  }
  return {
    version: 1,
    byLocation: v.byLocation,
    total: v.total ?? null,
  };
}

/**
 * El resumen: una sección por sede activa (en el orden de Reportes) y el
 * total de la clínica al final. El saldo vencido se compara con la foto del
 * envío de la semana anterior (`previousSnapshot`); sin ella (primera semana,
 * o la sede no estaba), sin variación.
 */
export function composeWeeklyDigest(
  sources: DigestSources,
  previousSnapshot: ReceivablesSnapshot | null,
): WeeklyDigest {
  const sections = sources.locations.map((location) =>
    sectionOf(
      location.locationId,
      location.name,
      location,
      previousSnapshot?.byLocation[location.locationId] ?? null,
    ),
  );
  sections.push(
    sectionOf(
      null,
      TOTAL_SECTION_NAME,
      sources.total,
      previousSnapshot?.total ?? null,
    ),
  );
  return {
    week: sources.week,
    previousWeek: sources.previousWeek,
    sections,
    receivablesSnapshot: receivablesSnapshotOf(sources),
  };
}
