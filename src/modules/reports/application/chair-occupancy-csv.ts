import type { OccupancyMetrics } from '../domain/chair-occupancy';
import type { ChairOccupancyReport } from './use-cases/get-chair-occupancy.use-case';
import { csvDocument, csvText } from '../../../shared/csv/csv-cells';

/*
 * CSV de «Ocupación por sillón» (DX-481): las mismas cifras que la pantalla,
 * una fila por sillón, la de «Sin sillón» y el total de cada sede. Sin
 * pacientes ni citas sueltas: solo minutos y conteos por sillón. UTF-8 con
 * BOM, CRLF y celdas protegidas contra fórmulas, como el resto de reportes.
 */
export const CHAIR_OCCUPANCY_CSV_TITLE = 'Ocupación por sillón';

export const CHAIR_OCCUPANCY_FORMULA =
  'Ocupación = reservados ÷ abiertos. Abiertos = horario de la sede − cierres de toda la sede − festivos. Reservados = citas no canceladas (inasistencias incluidas) dentro del horario; atendidos = citas atendidas.';

export const CHAIR_OCCUPANCY_CSV_COLUMNS = [
  'Sede',
  'Fila',
  'Sillón',
  'Horario de la sede',
  'Minutos abiertos',
  'Minutos reservados',
  '% ocupación',
  'Minutos atendidos',
  '% atendido',
  'Minutos de inasistencias',
  'Citas reservadas',
  'Citas atendidas',
  'Inasistencias',
] as const;

/** Una tasa 0..1 como % con 1 decimal; vacío sin base. */
function percent(rate: number | null): string {
  return rate === null ? '' : (rate * 100).toFixed(1);
}

function metricCells(m: OccupancyMetrics): string[] {
  return [
    m.openMinutes === null ? '' : String(m.openMinutes),
    String(m.reservedMinutes),
    percent(m.reservedRate),
    String(m.attendedMinutes),
    percent(m.attendedRate),
    String(m.noShowMinutes),
    String(m.reservedAppointments),
    String(m.attendedAppointments),
    String(m.noShowAppointments),
  ];
}

export function toChairOccupancyCsv(report: ChairOccupancyReport): string {
  const header = [
    [csvText(CHAIR_OCCUPANCY_CSV_TITLE)],
    [csvText('Período'), csvText(`${report.from} a ${report.to}`)],
    [
      csvText('Sede'),
      csvText(
        report.locationId !== null
          ? (report.locations[0]?.locationName ?? 'Una sede')
          : report.restrictedToLocations
            ? 'Todas tus sedes'
            : 'Todas las sedes',
      ),
    ],
    [csvText('Cómo se calcula'), csvText(CHAIR_OCCUPANCY_FORMULA)],
    [],
    CHAIR_OCCUPANCY_CSV_COLUMNS.map(csvText),
  ];
  const body: string[][] = report.locations.flatMap((l) => {
    const schedule = csvText(l.hasSchedule ? 'Sí' : 'Sin horario');
    const location = csvText(l.locationName);
    return [
      ...l.chairs.map((c) => [
        location,
        csvText('Sillón'),
        csvText(c.active ? c.chairName : `${c.chairName} (desactivado)`),
        schedule,
        ...metricCells(c),
      ]),
      ...(l.noChair
        ? [
            [
              location,
              csvText('Sin sillón'),
              csvText(''),
              schedule,
              ...metricCells(l.noChair),
            ],
          ]
        : []),
      [
        location,
        csvText('Total sede'),
        csvText(''),
        schedule,
        ...metricCells(l.totals),
      ],
    ];
  });
  return csvDocument([...header, ...body].map((cells) => cells.join(',')));
}
