import { csvDocument, csvText } from '../../../shared/csv/csv-cells';
import { civilDateIn } from '../../../shared/time/civil-day';
import type { RetentionFigures } from '../domain/retention';
import type {
  RetentionFilters,
  RetentionPatientsReport,
  RetentionReport,
} from './use-cases/get-retention.use-case';

/*
 * CSV de «Retención» (DX-260). Mismo formato que los demás reportes: UTF-8
 * con BOM, CRLF, texto entre comillas y celdas protegidas contra fórmulas
 * (los nombres de sedes, profesionales y pacientes los escribe la clínica).
 *  - El informe: una fila por sede y profesional, el subtotal de cada sede y
 *    el total, como la tabla; sin pacientes.
 *  - Una lista: sus pacientes con teléfono (la ficha ya lo enseña), sede y
 *    profesional de la última visita y si tienen cita futura; las fechas, en
 *    la zona de su sede.
 */
export const RETENTION_CSV_TITLE = 'Retención de pacientes';

const percent = (value: number | null) => (value === null ? '' : String(value));

function filterLines(filters: RetentionFilters, from: string, to: string) {
  return [
    [csvText('Período'), csvText(`${from} a ${to}`)],
    [csvText('Sede'), csvText(filters.locationName ?? 'Todas tus sedes')],
    [
      csvText('Profesional'),
      csvText(filters.providerName ?? (filters.providerId ? '' : 'Todos')),
    ],
    [
      csvText('Activo si vino en los últimos'),
      csvText(`${filters.activeMonths} meses`),
    ],
  ];
}

const FIGURE_HEADERS = [
  'Activos al inicio',
  'Nuevos',
  'Perdidos',
  'Activos al final',
  'Recuperados',
  'Retención %',
  'Nuevos sin regreso',
];

function figures(f: RetentionFigures): string[] {
  return [
    String(f.activeAtStart),
    String(f.newPatients),
    String(f.lost),
    String(f.activeAtEnd),
    String(f.reactivated),
    percent(f.retentionRate),
    String(f.newNoReturn),
  ];
}

export function toRetentionCsv(report: RetentionReport): string {
  const lines: string[][] = [
    [csvText(RETENTION_CSV_TITLE)],
    ...filterLines(report.filters, report.from, report.to),
    ...report.definitions.map((d) => [
      csvText(d.label),
      csvText(d.howItIsCalculated),
    ]),
    [],
    [csvText('Sede'), csvText('Profesional'), ...FIGURE_HEADERS.map(csvText)],
  ];
  for (const location of report.locations) {
    for (const row of report.rows.filter(
      (r) => r.locationId === location.locationId,
    )) {
      lines.push([
        csvText(row.locationName),
        csvText(row.providerName),
        ...figures(row),
      ]);
    }
    lines.push([
      csvText(location.locationName),
      csvText('Total sede'),
      ...figures(location),
    ]);
  }
  lines.push([csvText('Total'), csvText(''), ...figures(report.totals)]);
  return csvDocument(lines.map((cells) => cells.join(',')));
}

export function toRetentionPatientsCsv(
  report: RetentionPatientsReport,
): string {
  const lines: string[][] = [
    [csvText(`${RETENTION_CSV_TITLE}: ${report.definition.label}`)],
    ...filterLines(report.filters, report.from, report.to),
    [csvText('Cómo se calcula'), csvText(report.definition.howItIsCalculated)],
    [csvText('Pacientes'), String(report.total)],
    ...(report.truncated
      ? [
          [
            csvText('Aviso'),
            csvText(
              `Solo las ${report.items.length} primeras filas de ${report.total}.`,
            ),
          ],
        ]
      : []),
    [],
    [
      'Paciente',
      'Teléfono',
      'Baja de avisos',
      'Primera visita',
      'Última visita',
      'Sede',
      'Profesional',
      'Cita futura',
    ].map(csvText),
  ];
  for (const item of report.items) {
    lines.push([
      csvText(item.patientName),
      csvText(item.phone),
      csvText(item.reminderOptedOut ? 'Sí' : 'No'),
      csvText(civilDateIn(item.firstVisitAt, item.timeZone)),
      csvText(civilDateIn(item.lastVisitAt, item.timeZone)),
      csvText(item.locationName),
      csvText(item.providerName),
      csvText(item.hasUpcomingAppointment ? 'Sí' : 'No'),
    ]);
  }
  return csvDocument(lines.map((cells) => cells.join(',')));
}
