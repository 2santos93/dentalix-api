import type { DiscountReason, TreatmentPlanStatus } from '@prisma/client';
import type { DiscountReportRowView } from './use-cases/get-discount-report.use-case';
import { currencyDecimals } from '../domain/discount-policy';

/*
 * CSV del informe de descuentos (DX-204): una línea por ítem, mismos filtros
 * que la pantalla. SEC-041: precio de catálogo (vacío en un ítem libre), rebaja
 * de precio, descuento del ítem y el total, que es la suma de los dos. Nombres de pacientes y de personal: solo ADMIN y la
 * descarga queda auditada. Mismo formato que la cartera (DX-145) y los lotes
 * de implantes (DX-191): UTF-8 con BOM, CRLF, texto entre comillas y celdas
 * que empiezan (tras blancos) por = + - @ (o tabulador/CR) prefijadas con «'»
 * para que la hoja no las ejecute como fórmula (inyección CSV). La nota del
 * motivo es texto libre. SEC-047: al final, el convenio, el precio sin
 * convenio, la rebaja por convenio (aparte del descuento total), quién asignó
 * el convenio y quién creó el ítem.
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
  'Convenio',
  'Precio sin convenio',
  'Rebaja por convenio',
  'Convenio asignado por',
  'Ítem creado por',
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

/** En la unidad de la moneda: COP sin decimales, EUR a céntimos. */
function money(value: number, currency: string): string {
  return value.toFixed(currencyDecimals(currency));
}

function planLabel(row: DiscountReportRowView): string {
  const created = row.planCreatedOn;
  return row.planOptionLabel
    ? `Plan del ${created} · ${row.planOptionLabel}`
    : `Plan del ${created}`;
}

/** SEC-047: línea que solo tiene rebaja de convenio (sin descuento propio). */
function agreementOnly(row: DiscountReportRowView): boolean {
  return row.discount === 0 && row.agreementReduction > 0;
}

function reasonText(row: DiscountReportRowView): string {
  if (agreementOnly(row))
    return text(`Convenio ${row.agreementName ?? ''}`.trim());
  return row.reason ? text(DISCOUNT_REASON_LABELS[row.reason]) : '';
}

/** Quién: el del descuento; en una línea solo de convenio, quien lo asignó o creó el ítem. */
function authorText(row: DiscountReportRowView): string {
  if (agreementOnly(row)) {
    return text(row.agreementAssignedByName ?? row.createdByName);
  }
  return text(row.discountByName);
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
        reasonText(row),
        text(row.reasonNote),
        authorText(row),
        text(row.locationName),
        text(row.agreementName),
        row.agreementName === null || row.basePrice === null
          ? ''
          : money(row.basePrice, row.currency),
        money(row.agreementReduction, row.currency),
        text(row.agreementAssignedByName),
        text(row.createdByName),
      ].join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
