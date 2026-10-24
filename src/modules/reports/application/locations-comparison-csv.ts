import {
  KPI_DEFINITIONS,
  KPI_KEYS,
  type KpiChangeUnit,
  type KpiKey,
  type KpiTrend,
} from '../domain/kpi-definitions';
import type {
  ComparisonRow,
  CurrencyMetricView,
  LocationsComparison,
  MetricView,
} from './use-cases/get-locations-comparison.use-case';

/*
 * CSV de «Comparar sedes» (DX-014), con los mismos filtros que la pantalla.
 * Formato largo: una línea por sede (y el «Total clínica» al final),
 * indicador y moneda (con el aviso de BE-045 cuando no hay variación porque el
 * período comparado no tiene toda la producción atribuida), así una hoja de cálculo lo filtra y lo tabla sin tener
 * que deshacer columnas por moneda. Mismo formato que el informe de
 * descuentos (DX-204) y la cartera (DX-145): UTF-8 con BOM, CRLF, texto entre
 * comillas y las celdas de texto que empiezan (tras blancos) por = + - @ (o
 * tabulador/CR) prefijadas con «'» para que la hoja no las ejecute como
 * fórmula. Los nombres de sede los escribe la clínica.
 */
export const LOCATIONS_COMPARISON_CSV_HEADER = [
  'Período',
  'Comparado con',
  'Sede',
  'Indicador',
  'Moneda',
  'Valor',
  'Valor anterior',
  'Variación',
  'Unidad de la variación',
  'Evolución',
  'Aviso',
] as const;

/**
 * BE-045: por qué una producción o un % de cobro sale sin variación. Mismo
 * texto que el aviso de la pantalla.
 */
export const UNATTRIBUTED_PREVIOUS_CSV_NOTE =
  'Sin variación: el período comparado no tiene toda su producción atribuida a una sede';

const TREND_LABELS: Record<KpiTrend, string> = {
  BETTER: 'Mejora',
  WORSE: 'Empeora',
  EQUAL: 'Igual',
};

/** «%» relativo o «p.p.» (puntos) en los indicadores que son porcentajes. */
const CHANGE_UNIT_LABELS: Record<KpiChangeUnit, string> = {
  PERCENT: '%',
  POINTS: 'p.p.',
};

const FORMULA_START = /^[\s]*[=+\-@]|^[\t\r]/;

function text(value: string): string {
  const raw = value.replace(/[\r\n]+/g, ' ');
  const safe = FORMULA_START.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

function num(value: number | null, decimals: number): string {
  return value === null ? '' : value.toFixed(decimals);
}

function metricsOf(
  row: ComparisonRow,
  key: KpiKey,
): (MetricView & Partial<CurrencyMetricView>)[] {
  const value: MetricView | CurrencyMetricView[] = row.metrics[key];
  return Array.isArray(value) ? value : [value];
}

export function toLocationsComparisonCsv(report: LocationsComparison): string {
  const period = `${report.from} a ${report.to}`;
  const previous =
    report.previousFrom && report.previousTo
      ? `${report.previousFrom} a ${report.previousTo}`
      : '';
  const lines: string[] = [LOCATIONS_COMPARISON_CSV_HEADER.join(',')];
  for (const row of [...report.locations, report.total]) {
    for (const key of KPI_KEYS) {
      const def = KPI_DEFINITIONS[key];
      const decimals = def.unit === 'COUNT' ? 0 : 2;
      for (const m of metricsOf(row, key)) {
        lines.push(
          [
            period,
            previous,
            text(row.name),
            text(def.label),
            m.currency ?? '',
            num(m.value, decimals),
            num(m.previous, decimals),
            num(m.change, 1),
            m.change === null ? '' : CHANGE_UNIT_LABELS[def.changeUnit],
            m.trend ? TREND_LABELS[m.trend] : '',
            m.previousUnattributed ? text(UNATTRIBUTED_PREVIOUS_CSV_NOTE) : '',
          ].join(','),
        );
      }
    }
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
