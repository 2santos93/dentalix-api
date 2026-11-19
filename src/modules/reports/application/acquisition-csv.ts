import { csvAmount } from '../../../shared/csv/csv-cells';
import type { AcquisitionReport } from './use-cases/get-acquisition.use-case';

/*
 * CSV de «Captación» (DX-172): una fila por fuente, como la tabla, y el
 * total. Sin datos de pacientes (ni el top de referentes). Mismo formato que
 * los demás reportes: UTF-8 con BOM, CRLF, texto entre comillas y celdas que
 * empiezan por = + - @ (o tabulador/CR) prefijadas con «'» (el nombre de la
 * fuente y el de la sede los escribe la clínica). Lo cobrado, una columna por
 * moneda, sin convertir ni sumar monedas.
 */
export const ACQUISITION_CSV_TITLE = 'Captación de pacientes';

const KIND_LABEL: Record<string, string> = {
  CHANNEL: 'Canal',
  PATIENT: 'Recomendación de paciente',
  EXTERNAL_PROFESSIONAL: 'Profesional externo',
};

const FORMULA_START = /^[\s]*[=+\-@]|^[\t\r]/;

function text(value: string): string {
  const raw = value.replace(/[\r\n]+/g, ' ');
  const safe = FORMULA_START.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toAcquisitionCsv(report: AcquisitionReport): string {
  const currencies = report.currencies;
  const header = [
    [text(ACQUISITION_CSV_TITLE)],
    [text('Período'), text(`${report.period.from} a ${report.period.to}`)],
    [text('Sede'), text(report.filters.locationName ?? 'Todas tus sedes')],
    [
      text('Cómo se calcula'),
      text(
        'Pacientes dados de alta en el período por «¿Cómo nos conoció?» (sede: la de su primera cita); cobrado: sus abonos no anulados del período, por moneda',
      ),
    ],
    [],
    [
      text('Fuente'),
      text('Tipo'),
      text('Estado'),
      text('Pacientes nuevos'),
      text('Con abonos'),
      ...currencies.map((c) => text(`Cobrado ${c}`)),
    ],
  ];
  const amountIn = (
    list: readonly { currency: string; amount: number }[],
    currency: string,
  ) =>
    csvAmount(list.find((a) => a.currency === currency)?.amount ?? 0, currency);
  const body: string[][] = report.rows.map((r) => [
    text(r.name),
    text(r.kind ? KIND_LABEL[r.kind] : ''),
    text(r.isActive === null ? '' : r.isActive ? 'Activa' : 'Desactivada'),
    String(r.newPatients),
    String(r.payingPatients),
    ...currencies.map((c) => amountIn(r.collected, c)),
  ]);
  body.push([
    text('Total'),
    text(''),
    text(''),
    String(report.totals.newPatients),
    String(report.totals.payingPatients),
    ...currencies.map((c) => amountIn(report.totals.collected, c)),
  ]);
  const lines = [...header, ...body].map((cells) => cells.join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
