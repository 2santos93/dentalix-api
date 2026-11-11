import type { RecoveredSlotsMetrics } from '../domain/recovered-slots';
import type { RecoveredSlotsReport } from './use-cases/get-recovered-slots.use-case';
import { csvAmount, csvDocument, csvText } from '../../../shared/csv/csv-cells';

/*
 * CSV de «Huecos recuperados» (DX-436): SOLO agregados — el total, una fila
 * por profesional y una por semana —, con las mismas cifras que la pantalla.
 * Ni una fila por hueco: con la hora, el profesional y la sede de cada hueco
 * cancelado se reconstruye quién faltó a qué cita, y el informe no necesita
 * ese detalle. Sin pacientes, procedimientos ni notas; el nombre del
 * profesional es del personal. UTF-8 con BOM, CRLF y celdas protegidas
 * contra fórmulas, como el resto de reportes.
 */
export const RECOVERED_SLOTS_CSV_TITLE = 'Huecos recuperados';

export const RECOVERED_SLOTS_CSV_COLUMNS = [
  'Fila',
  'Profesional o semana',
  'Huecos liberados',
  'Minutos liberados',
  'Rellenados',
  'Rellenados en parte',
  'Minutos recuperados',
  'Por la lista',
  '% relleno',
  '% rellenado en 30 min',
  '% rellenado en 24 h',
  'Minutos medios hasta rellenar',
  '% cancelación',
  'Ofertas enviadas',
  'Ofertas aceptadas',
  'Ofertas rechazadas',
  'Ofertas sin respuesta',
  'Recuperados sin valorar',
] as const;

/** Una tasa 0..1 como % con 1 decimal; vacío sin base. */
function percent(rate: number | null): string {
  return rate === null ? '' : (rate * 100).toFixed(1);
}

/** Minutos enteros; vacío sin dato. */
function minutes(value: number | null): string {
  return value === null ? '' : String(Math.round(value));
}

function metricCells(
  m: RecoveredSlotsMetrics,
  currencies: readonly string[],
): string[] {
  const values = new Map(m.recoveredValue.map((v) => [v.currency, v.amount]));
  return [
    String(m.freedSlots),
    minutes(m.freedMinutes),
    String(m.filledSlots),
    String(m.partiallyFilledSlots),
    minutes(m.recoveredMinutes),
    String(m.filledByListSlots),
    percent(m.fillRate),
    percent(m.filledWithin30MinRate),
    percent(m.filledWithin24hRate),
    minutes(m.meanMinutesToFill),
    percent(m.cancellationRate),
    String(m.offers.sent),
    String(m.offers.accepted),
    String(m.offers.declined),
    String(m.offers.unanswered),
    String(m.unvaluedRecoveredSlots),
    ...currencies.map((c) => csvAmount(values.get(c) ?? 0, c)),
  ];
}

export function toRecoveredSlotsCsv(report: RecoveredSlotsReport): string {
  // Una columna de valor por moneda del total (las de cualquier fila están
  // en él): nunca se suman monedas.
  const currencies = report.totals.recoveredValue.map((v) => v.currency);
  const header = [
    [csvText(RECOVERED_SLOTS_CSV_TITLE)],
    [csvText('Período'), csvText(`${report.from} a ${report.to}`)],
    [
      csvText('Sede'),
      csvText(
        report.locationId !== null
          ? 'Una sede'
          : report.restrictedToLocations
            ? 'Todas tus sedes'
            : 'Todas las sedes',
      ),
    ],
    [
      csvText('Profesional'),
      csvText(
        report.providerId === null
          ? 'Todo el equipo'
          : (report.byProvider[0]?.providerName ?? 'Sin actividad'),
      ),
    ],
    [
      csvText('Hueco liberado'),
      csvText('Cancelación o inasistencia con al menos 1 h de aviso'),
    ],
    [],
    [
      ...RECOVERED_SLOTS_CSV_COLUMNS,
      ...currencies.map((c) => `Valor recuperado (${c})`),
    ].map(csvText),
  ];
  const body: string[][] = [
    [csvText('Total'), csvText(''), ...metricCells(report.totals, currencies)],
    ...report.byProvider.map((p) => [
      csvText('Profesional'),
      csvText(p.providerName),
      ...metricCells(p, currencies),
    ]),
    ...report.byWeek.map((w) => [
      csvText('Semana'),
      csvText(w.weekStart),
      ...metricCells(w, currencies),
    ]),
  ];
  return csvDocument([...header, ...body].map((cells) => cells.join(',')));
}
