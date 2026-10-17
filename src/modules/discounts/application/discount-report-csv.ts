import type { DiscountReason, TreatmentPlanStatus } from '@prisma/client';
import type { DiscountReportRowView } from './use-cases/get-discount-report.use-case';

/*
 * CSV del informe de descuentos (DX-204): una línea por ítem, mismos filtros
 * que la pantalla. Nombres de pacientes y de personal: solo ADMIN y la
 * descarga queda auditada. Mismo formato que la cartera (DX-145) y los lotes
 * de implantes (DX-191): UTF-8 con BOM, CRLF, texto entre comillas y celdas
 * que empiezan (tras blancos) por = + - @ (o tabulador/CR) prefijadas con «'»
 * para que la hoja no las ejecute como fórmula (inyección CSV). La nota del
 * motivo es texto libre.
 */
export const DISCOUNT_REPORT_CSV_HEADER = [
  'Fecha',
  'Paciente',
  'Plan',
  'Estado del plan',
  'Diente',
  'Procedimiento',
  'Moneda',
  'Precio',
  'Descuento',
  'Descuento (%)',
  'Motivo',
  'Nota del motivo',
  'Dado por',
  'Sede',
] as const;

// Mismas etiquetas que la web.
export const DISCOUNT_REASON_LABELS: Record<DiscountReason, string> = {
  LOYALTY: 'Paciente frecuente',
  FAMILY_OR_STAFF: 'Familiar o personal de la clínica',
  PROMOTION: 'Promoción o campaña',
  FINANCIAL_HARDSHIP: 'Situación económica del paciente',
  SERVICE_RECOVERY: 'Compensación por una incidencia',
  OTHER: 'Otro',
};

const PLAN_STATUS_LABELS: Record<TreatmentPlanStatus, string> = {
  DRAFT: 'Borrador',
  PRESENTED: 'Presentado',
  ACCEPTED: 'Aceptado',
  REJECTED: 'Rechazado',
  COMPLETED: 'Completado',
  CANCELLED: 'Cancelado',
};

const FORMULA_START = /^[\s]*[=+\-@]|^[\t\r]/;

function text(value: string | null): string {
  const raw = (value ?? '').replace(/[\r\n]+/g, ' ');
  const safe = FORMULA_START.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

function money(value: number): string {
  return value.toFixed(2);
}

function planLabel(row: DiscountReportRowView): string {
  const created = row.planCreatedOn;
  return row.planOptionLabel
    ? `Plan del ${created} · ${row.planOptionLabel}`
    : `Plan del ${created}`;
}

export function toDiscountReportCsv(
  rows: readonly DiscountReportRowView[],
): string {
  const lines: string[] = [DISCOUNT_REPORT_CSV_HEADER.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.discountOn,
        text(row.patientName),
        text(planLabel(row)),
        PLAN_STATUS_LABELS[row.planStatus],
        row.toothNumber,
        text(row.procedure),
        row.currency,
        money(row.price),
        money(row.discount),
        row.percent.toFixed(2),
        row.reason ? text(DISCOUNT_REASON_LABELS[row.reason]) : '',
        text(row.reasonNote),
        text(row.discountByName),
        text(row.locationName),
      ].join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
