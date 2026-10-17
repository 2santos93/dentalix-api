import type {
  CollectionChannel,
  CollectionOutcome,
  PaymentPromiseStatus,
} from '@prisma/client';
import type { AgingCsvRow } from './use-cases/get-receivables-aging.use-case';

/*
 * CSV de la cartera (DX-145): una línea por paciente y moneda, con los mismos
 * filtros que la lista. Es un dato personal (nombre y teléfono): solo lo
 * descarga ADMIN y la descarga queda auditada (ver el controlador).
 *
 * - UTF-8 con BOM y CRLF (RFC 4180): Excel lo abre con tildes bien.
 * - Importes con punto decimal y dos decimales, sin separador de miles.
 * - Texto entre comillas; una celda que empieza por = + - @ (o tabulador/CR)
 *   se antepone con «'» para que la hoja no la ejecute como fórmula (inyección
 *   CSV). El nombre y el teléfono son texto libre.
 * - «Fecha aproximada» = Sí cuando parte de la deuda envejece desde la fecha
 *   del plan y no desde un vencimiento (nunca en silencio).
 * - DX-150: al final, la última gestión de cobro (canal · resultado y su día
 *   en la zona de la sede de la deuda; NUNCA el texto de la nota) y el último
 *   compromiso de pago con su estado.
 */
export const RECEIVABLES_CSV_HEADER = [
  'Paciente',
  'Teléfono',
  'Moneda',
  'Deuda',
  'Por vencer',
  '0-30 días',
  '31-60 días',
  '61-90 días',
  'Más de 90 días',
  'Saldo a favor',
  'Saldo neto',
  'Antigüedad (días)',
  'Fecha aproximada',
  'Último abono',
  'Importe último abono',
  'Moneda último abono',
  'Próxima cuota',
  'Importe próxima cuota',
  'Última gestión',
  'Fecha última gestión',
  'Compromiso',
  'Importe compromiso',
  'Moneda compromiso',
  'Fecha compromiso',
] as const;

// Mismas etiquetas que la pantalla de la cartera (web).
const CHANNEL_LABELS: Record<CollectionChannel, string> = {
  CALL: 'Llamada',
  WHATSAPP_LINK: 'WhatsApp',
  EMAIL: 'Email',
  IN_PERSON: 'En persona',
};
const OUTCOME_LABELS: Record<CollectionOutcome, string> = {
  NO_ANSWER: 'No contesta',
  PROMISED_PAYMENT: 'Promete pago',
  WILL_PAY_AT_APPOINTMENT: 'Pagará en la cita',
  DISPUTE: 'Disputa el saldo',
  WRONG_NUMBER: 'Número erróneo',
};
const PROMISE_STATUS_LABELS: Record<PaymentPromiseStatus, string> = {
  OPEN: 'Abierto',
  KEPT: 'Cumplido',
  BROKEN: 'Incumplido',
};

const FORMULA_START = /^[=+\-@\t\r]/;

function text(value: string | null): string {
  const raw = value ?? '';
  const safe = FORMULA_START.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

function money(value: number): string {
  return value.toFixed(2);
}

export function toReceivablesCsv(rows: readonly AgingCsvRow[]): string {
  const lines: string[] = [RECEIVABLES_CSV_HEADER.join(',')];
  for (const row of rows) {
    for (const c of row.currencies) {
      lines.push(
        [
          text(row.patient.fullName),
          text(row.patient.phone),
          c.currency,
          money(c.debt),
          money(c.buckets.current),
          money(c.buckets.days0to30),
          money(c.buckets.days31to60),
          money(c.buckets.days61to90),
          money(c.buckets.over90),
          money(c.credit),
          money(c.balance),
          c.oldestAgeDays === null ? '' : String(c.oldestAgeDays),
          c.debt > 0 && c.ageApproximate ? 'Sí' : 'No',
          row.lastPayment?.paidOn ?? '',
          row.lastPayment ? money(row.lastPayment.amount) : '',
          row.lastPayment?.currency ?? '',
          c.nextInstallment
            ? c.nextInstallment.dueDate.toISOString().slice(0, 10)
            : '',
          c.nextInstallment ? money(c.nextInstallment.amount) : '',
          row.lastNote
            ? text(
                `${CHANNEL_LABELS[row.lastNote.channel]} · ${OUTCOME_LABELS[row.lastNote.outcome]}`,
              )
            : '',
          row.lastNoteOn ?? '',
          row.promise ? text(PROMISE_STATUS_LABELS[row.promise.status]) : '',
          row.promise ? money(row.promise.amount) : '',
          row.promise?.currency ?? '',
          row.promise?.dueDate ?? '',
        ].join(','),
      );
    }
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
