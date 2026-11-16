import { csvAmount, csvDocument, csvText } from '../../../shared/csv/csv-cells';
import {
  QUOTE_FUNNEL_DEFINITIONS,
  type AcceptanceRate,
  type CountAmount,
} from '../domain/quote-funnel';
import type {
  QuoteFunnelReport,
  QuoteFunnelStepAmounts,
} from './use-cases/get-quote-funnel.use-case';

/*
 * CSV del «Embudo de presupuestos» (DX-558), con los mismos filtros y las
 * MISMAS definiciones que la pantalla (`QUOTE_FUNNEL_DEFINITIONS`): una
 * cabecera con el período, la sede, el profesional y la moneda, y una fila
 * por profesional que lo elaboró más el «Total», con cada paso (número e
 * importe), las tasas de aceptación y la mediana de días. Sin datos de
 * pacientes. UTF-8 con BOM, CRLF y celdas de texto protegidas contra fórmulas
 * (`csvText`); importes con los decimales de la pantalla (`csvAmount`).
 */

const D = QUOTE_FUNNEL_DEFINITIONS;

export const QUOTE_FUNNEL_CSV_TITLE = 'Embudo de presupuestos';
export const QUOTE_FUNNEL_CSV_TOTAL = 'Total';

export const QUOTE_FUNNEL_CSV_COLUMNS = [
  D.PROFESSIONAL.label,
  D.PRESENTED.label,
  `Importe ${D.PRESENTED.label.toLowerCase()}`,
  D.ACCEPTED.label,
  `Importe ${D.ACCEPTED.label.toLowerCase()}`,
  D.SCHEDULED.label,
  `Importe ${D.SCHEDULED.label.toLowerCase()}`,
  D.DONE.label,
  `Importe ${D.DONE.label.toLowerCase()}`,
  D.COLLECTED.label,
  `Importe ${D.COLLECTED.label.toLowerCase()}`,
  `${D.ACCEPTANCE_RATE.label} por número (%)`,
  `${D.ACCEPTANCE_RATE.label} por importe (%)`,
  D.MEDIAN_DAYS_TO_ACCEPT.label,
] as const;

/** Un número de 1 decimal tal cual (tasas, días); vacío = sin dato. */
const decimal = (value: number | null) => (value === null ? '' : String(value));

export function toQuoteFunnelCsv(report: QuoteFunnelReport): string {
  const currency = report.currency;
  const amount = (pair: CountAmount) =>
    currency === null || pair.amount === null
      ? ''
      : csvAmount(pair.amount, currency);
  const row = (
    name: string,
    steps: QuoteFunnelStepAmounts,
    rate: AcceptanceRate,
    median: number | null,
  ) =>
    [
      csvText(name),
      ...[
        steps.presented,
        steps.accepted,
        steps.scheduled,
        steps.done,
        steps.collected,
      ].flatMap((pair) => [String(pair.count), amount(pair)]),
      decimal(rate.byCount),
      decimal(rate.byAmount),
      decimal(median),
    ].join(',');

  const location = report.options.locations.find(
    (l) => l.id === report.filters.locationId,
  );
  const professional = report.byProfessional.find(
    (p) =>
      report.filters.providerId !== null &&
      p.professionalId === report.filters.providerId,
  );
  const header = (label: string, value: string) =>
    [csvText(label), csvText(value)].join(',');
  const [presented, accepted, scheduled, done, collected] = report.steps;
  const pair = (s: (typeof report.steps)[number]): CountAmount => ({
    count: s.count,
    amount: s.amount,
  });

  return csvDocument([
    csvText(QUOTE_FUNNEL_CSV_TITLE),
    header('Período', `${report.period.from} a ${report.period.to}`),
    header(
      'Sede',
      location?.name ??
        (report.restrictedToLocations ? 'Tus sedes' : 'Todas las sedes'),
    ),
    header(
      D.PROFESSIONAL.label,
      report.filters.providerId === null
        ? 'Todos'
        : (professional?.name ?? report.filters.providerId),
    ),
    header('Moneda', currency ?? 'Sin moneda de catálogo: sin importes'),
    header(
      'Presentaciones fuera de los importes (sin tasa)',
      String(report.withoutRate.presentations),
    ),
    '',
    QUOTE_FUNNEL_CSV_COLUMNS.map((c) => csvText(c)).join(','),
    ...report.byProfessional.map((p) =>
      row(p.name, p, p.acceptanceRate, p.medianDaysToAccept),
    ),
    row(
      QUOTE_FUNNEL_CSV_TOTAL,
      {
        presented: pair(presented),
        accepted: pair(accepted),
        scheduled: pair(scheduled),
        done: pair(done),
        collected: pair(collected),
      },
      report.acceptanceRate,
      report.medianDaysToAccept,
    ),
  ]);
}
