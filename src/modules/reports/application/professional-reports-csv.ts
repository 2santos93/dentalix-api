import type { CancellationReasonCode } from '@prisma/client';
import { csvAmount, csvDocument, csvText } from '../../../shared/csv/csv-cells';
import { civilDateIn, wallMillisOfDay } from '../../../shared/time/civil-day';
import type { ProductivityFigures } from '../domain/professional-productivity';
import type {
  ProfessionalProductivity,
  ProfessionalReportFilters,
} from './use-cases/get-professional-productivity.use-case';
import type { NoShowsReport } from './use-cases/get-no-shows.use-case';

/*
 * CSV de «Profesionales» e «Inasistencias» (DX-304), con el formato de los
 * demás reportes: UTF-8 con BOM, CRLF, texto entre comillas y celdas que
 * empiezan por = + - @ (o tabulador/CR) prefijadas con «'» (`csvText`): el
 * nombre del profesional, del paciente, de la sede y del tipo de cita los
 * escribe la clínica. Importes con los decimales de la pantalla (`csvAmount`)
 * y por moneda, sin convertir. El período y los filtros van en la cabecera.
 */

export const PRODUCTIVITY_CSV_TITLE = 'Productividad por profesional';
export const NO_SHOWS_CSV_TITLE = 'Inasistencias';

export const PRODUCTIVITY_CSV_COLUMNS = [
  'Fila',
  'Profesional',
  'Moneda',
  'Procedimientos realizados',
  'Producción',
  'Cobrado',
  'Citas atendidas',
  'No asistió',
  'Cancelaciones tardías',
  'No-show %',
] as const;

export const NO_SHOWS_CSV_COLUMNS = [
  'Fecha',
  'Hora',
  'Tipo',
  'Paciente',
  'Profesional',
  'Sede',
  'Tipo de cita',
  'Motivo de la cancelación',
  'Aviso (horas)',
] as const;

// Los mismos textos que la web (`CANCELLATION_REASON_LABELS`).
const REASON_LABELS: Record<CancellationReasonCode, string> = {
  ILLNESS: 'Enfermedad',
  FORGOT: 'Olvido',
  COST: 'Costo',
  TRANSPORT: 'Transporte',
  WORK: 'Trabajo',
  CLINIC_RESCHEDULE: 'La clínica reprograma',
  OTHER: 'Otro',
};

const percent = (value: number | null) =>
  value === null ? '' : value.toFixed(2);

function professionalLine(
  scope: 'CLINIC' | 'OWN',
  filters: ProfessionalReportFilters,
): string {
  const name = filters.professionalName;
  if (scope === 'OWN') return name ? `Solo lo tuyo (${name})` : 'Solo lo tuyo';
  if (filters.professionalId === null) return 'Todo el equipo';
  return name ?? 'Profesional sin datos en esta clínica';
}

function header(
  title: string,
  report: {
    from: string;
    to: string;
    scope: 'CLINIC' | 'OWN';
    filters: ProfessionalReportFilters;
  },
): string[][] {
  return [
    [csvText(title)],
    [csvText('Período'), csvText(`${report.from} a ${report.to}`)],
    [
      csvText('Sede'),
      csvText(report.filters.locationName ?? 'Todas tus sedes'),
    ],
    [
      csvText('Profesional'),
      csvText(professionalLine(report.scope, report.filters)),
    ],
  ];
}

/**
 * Las líneas de una fila (o del total): una por moneda con producción o
 * cobrado; las citas, solo en la primera (sumar la columna no las duplica).
 */
function figureLines(
  kind: string,
  name: string,
  f: ProductivityFigures,
): string[][] {
  const currencies = [
    ...new Set([
      ...f.production.map((p) => p.currency),
      ...f.collected.map((c) => c.currency),
    ]),
  ].sort();
  const counts = [
    String(f.completedAppointments),
    String(f.noShows),
    String(f.lateCancellations),
    percent(f.noShowRate),
  ];
  if (currencies.length === 0) {
    return [[csvText(kind), csvText(name), csvText(''), '', '', '', ...counts]];
  }
  return currencies.map((currency, index) => {
    const produced = f.production.find((p) => p.currency === currency);
    const collected = f.collected.find((c) => c.currency === currency);
    return [
      csvText(kind),
      csvText(name),
      csvText(currency),
      String(produced?.count ?? 0),
      csvAmount(produced?.net ?? 0, currency),
      csvAmount(collected?.amount ?? 0, currency),
      ...(index === 0 ? counts : ['', '', '', '']),
    ];
  });
}

export function toProfessionalProductivityCsv(
  report: ProfessionalProductivity,
): string {
  const lines: string[][] = [
    ...header(PRODUCTIVITY_CSV_TITLE, report),
    [csvText('Importes'), csvText('Por moneda, sin convertir')],
    [],
    PRODUCTIVITY_CSV_COLUMNS.map(csvText),
  ];
  for (const row of report.rows) {
    lines.push(...figureLines('Profesional', row.fullName, row));
  }
  if (report.scope === 'CLINIC' && report.rows.length > 0) {
    lines.push(...figureLines('Total', '', report.totals));
  }
  return csvDocument(lines.map((cells) => cells.join(',')));
}

function hourText(instant: Date, timeZone: string): string {
  const minutes = Math.floor(wallMillisOfDay(instant, timeZone) / 60_000);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function toNoShowsCsv(report: NoShowsReport): string {
  const s = report.summary;
  const lines: string[][] = [
    ...header(NO_SHOWS_CSV_TITLE, report),
    [csvText('Citas atendidas'), String(s.completedAppointments)],
    [csvText('No asistió'), String(s.noShows)],
    [csvText('Cancelaciones tardías'), String(s.lateCancellations)],
    [csvText('No-show %'), percent(s.noShowRate)],
    [csvText('Cómo se calcula'), csvText(report.definition.howItIsCalculated)],
    ...(report.truncated
      ? [
          [
            csvText('Aviso'),
            csvText(
              `Solo las ${report.items.length} citas más recientes de ${report.total}: acota el período.`,
            ),
          ],
        ]
      : []),
    [],
    NO_SHOWS_CSV_COLUMNS.map(csvText),
  ];
  for (const item of report.items) {
    lines.push([
      csvText(civilDateIn(item.start, item.timeZone)),
      csvText(hourText(item.start, item.timeZone)),
      csvText(item.kind === 'NO_SHOW' ? 'No asistió' : 'Cancelación tardía'),
      csvText(item.patientName),
      csvText(item.professionalName ?? ''),
      csvText(item.locationName),
      csvText(item.appointmentTypeName ?? ''),
      csvText(
        item.cancelReasonCode ? REASON_LABELS[item.cancelReasonCode] : '',
      ),
      item.noticeMinutes === null ? '' : (item.noticeMinutes / 60).toFixed(1),
    ]);
  }
  return csvDocument(lines.map((cells) => cells.join(',')));
}
