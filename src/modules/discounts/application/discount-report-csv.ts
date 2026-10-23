import type { DiscountReason, TreatmentPlanStatus } from '@prisma/client';
import type { DiscountReportRowView } from './use-cases/get-discount-report.use-case';
import {
  csvAmount,
  csvDocument,
  csvText as text,
} from '../../../shared/csv/csv-cells';
import { currencyDecimals } from '../domain/discount-policy';

/*
 * CSV del informe de descuentos (DX-204): una línea por ítem, mismos filtros
 * que la pantalla. SEC-041: precio de catálogo (vacío en un ítem libre), rebaja
 * de precio, descuento del ítem y el total, que es la suma de los dos. Nombres de pacientes y de personal: solo ADMIN y la
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
  'Precio de catálogo',
  'Precio',
  'Rebaja de precio',
  'Descuento del ítem',
  'Descuento total',
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

function money(value: number, currency: string): string {
  return csvAmount(value, currencyDecimals(currency));
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
        text(row.toothNumber),
        text(row.procedure),
        row.currency,
        row.catalogPrice === null ? '' : money(row.catalogPrice, row.currency),
        money(row.price, row.currency),
        money(row.priceReduction, row.currency),
        money(row.itemDiscount, row.currency),
        money(row.discount, row.currency),
        row.percent.toFixed(2),
        row.reason ? text(DISCOUNT_REASON_LABELS[row.reason]) : '',
        text(row.reasonNote),
        text(row.discountByName),
        text(row.locationName),
      ].join(','),
    );
  }
  return csvDocument(lines);
}
