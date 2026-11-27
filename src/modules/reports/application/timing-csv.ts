import { csvDocument, csvText } from '../../../shared/csv/csv-cells';
import type { OccupancyFigures, TimingFigures } from '../domain/timing';
import type { TimingReport } from './use-cases/get-timing.use-case';

/*
 * CSV de «Tiempos» (DX-275). Mismo formato que los demás reportes: UTF-8 con
 * BOM, CRLF, texto entre comillas y celdas protegidas contra fórmulas (los
 * nombres de sedes, profesionales y tipos los escribe la clínica). Las mismas
 * tablas que la pantalla, una tras otra, con el período, los filtros y las
 * definiciones en la cabecera. Minutos con 1 decimal (punto). Sin pacientes.
 */
export const TIMING_CSV_TITLE = 'Tiempos de la agenda';

const num = (value: number | null) => (value === null ? '' : String(value));

const FIGURE_HEADERS = [
  'Citas atendidas',
  'Con tiempos',
  'Sin tiempos',
  'Incoherentes',
  'Espera media (min)',
  'Espera p90 (min)',
  'Retraso de inicio medio (min)',
  'Retraso de inicio p90 (min)',
  'Duración real media (min)',
  'Duración real p90 (min)',
  'Duración programada media (min)',
  'Real frente a programada %',
];

function figures(f: TimingFigures): string[] {
  return [
    String(f.completed),
    String(f.measured),
    String(f.withoutTimes),
    String(f.incoherent),
    num(f.waitAvgMinutes),
    num(f.waitP90Minutes),
    num(f.startDelayAvgMinutes),
    num(f.startDelayP90Minutes),
    num(f.durationAvgMinutes),
    num(f.durationP90Minutes),
    num(f.plannedAvgMinutes),
    num(f.durationVsPlannedPercent),
  ];
}

const OCCUPANCY_HEADERS = [
  'Disponibles (min)',
  'Citadas (min)',
  'Atendidas (min)',
  'No-show (min)',
  'Libres (min)',
  'Ocupación %',
];

function occupancy(f: OccupancyFigures): string[] {
  return [
    String(f.availableMinutes),
    String(f.bookedMinutes),
    String(f.attendedMinutes),
    String(f.noShowMinutes),
    String(f.freeMinutes),
    num(f.occupancyPercent),
  ];
}

export function toTimingCsv(report: TimingReport): string {
  const lines: string[][] = [
    [csvText(TIMING_CSV_TITLE)],
    [csvText('Período'), csvText(`${report.from} a ${report.to}`)],
    [
      csvText('Sede'),
      csvText(report.filters.locationName ?? 'Todas tus sedes'),
    ],
    [
      csvText('Profesional'),
      csvText(
        report.filters.providerName ??
          (report.filters.providerId ? '' : 'Todos'),
      ),
    ],
    [csvText('Alcance'), csvText(report.scopeNote)],
    ...report.definitions.map((d) => [
      csvText(d.label),
      csvText(d.howItIsCalculated),
    ]),
    [],
    [csvText('Por profesional')],
    [csvText('Profesional'), ...FIGURE_HEADERS.map(csvText)],
    ...report.byProfessional.map((r) => [
      csvText(r.providerName),
      ...figures(r),
    ]),
    [csvText('Total'), ...figures(report.totals)],
    [],
    [csvText('Por tipo de cita')],
    [
      csvText('Tipo de cita'),
      csvText('Duración del tipo (min)'),
      ...FIGURE_HEADERS.map(csvText),
      csvText('Se excede'),
    ],
    ...report.byAppointmentType.map((r) => [
      csvText(r.appointmentTypeName),
      num(r.catalogDurationMinutes),
      ...figures(r),
      csvText(r.exceedsPlanned ? 'Sí' : 'No'),
    ]),
    [],
    [csvText('Por semana')],
    [
      csvText('Semana (lunes)'),
      csvText('Desde'),
      csvText('Hasta'),
      ...FIGURE_HEADERS.map(csvText),
    ],
    ...report.byWeek.map((r) => [
      csvText(r.weekStart),
      csvText(r.from),
      csvText(r.to),
      ...figures(r),
    ]),
    [],
    [csvText('Ocupación por profesional')],
    [
      csvText('Profesional'),
      csvText('Con horario'),
      ...OCCUPANCY_HEADERS.map(csvText),
    ],
    ...report.occupancy.professionals.map((r) => [
      csvText(r.providerName),
      csvText(r.hasSchedule ? 'Sí' : 'No'),
      ...occupancy(r),
    ]),
    [csvText('Total'), csvText(''), ...occupancy(report.occupancy.totals)],
    [],
    [csvText('Ocupación por semana')],
    [
      csvText('Profesional'),
      csvText('Semana (lunes)'),
      csvText('Desde'),
      csvText('Hasta'),
      ...OCCUPANCY_HEADERS.map(csvText),
    ],
    ...report.occupancy.professionals.flatMap((r) =>
      r.weeks.map((w) => [
        csvText(r.providerName),
        csvText(w.weekStart),
        csvText(w.from),
        csvText(w.to),
        ...occupancy(w),
      ]),
    ),
  ];
  return csvDocument(lines.map((cells) => cells.join(',')));
}
