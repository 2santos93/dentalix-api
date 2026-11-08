import type { DiscountReason, TreatmentPlanStatus } from '@prisma/client';
import type { DiscountReportRowView } from './use-cases/get-discount-report.use-case';
import {
  csvAmount,
  csvDocument,
  csvText as text,
} from '../../../shared/csv/csv-cells';
import { amountText } from '../../../shared/money/money';

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
 * el convenio y quién creó el ítem. DX-513-bis: el precio de catálogo va en
 * SU moneda («Moneda del catálogo»; antes se etiquetaba con la del plan), con
 * la referencia en la moneda del plan con la que se midió la rebaja y la tasa
 * congelada (unidades por 1 USD de las dos monedas, fuente y día). El CSV
 * nunca convierte. DX-513-ter: la tasa es siempre la del CATÁLOGO a la del
 * plan (en las listas de convenio, la de la base); la rebaja por convenio va
 * VACÍA (nunca 0.00) en las líneas de convenio que no se pudieron medir, y al
 * final, sin mover las demás columnas, el precio sin convenio en la moneda
 * del catálogo y si la rebaja por convenio se midió.
 */
export const DISCOUNT_REPORT_CSV_HEADER = [
  'Fecha',
  'Paciente',
  'Plan',
  'Estado del plan',
  'Diente',
  'Procedimiento',
  'Moneda',
  'Moneda del catálogo',
  'Precio de catálogo',
  'Precio de catálogo en la moneda del plan',
  'Tasa (por 1 USD: catálogo / plan)',
  'Fuente de la tasa',
  'Fecha de la tasa',
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
  'Precio sin convenio en la moneda del catálogo',
  'Rebaja por convenio medida',
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

const RATE_SOURCE_LABELS: Record<'AUTOMATIC' | 'MANUAL', string> = {
  AUTOMATIC: 'Automática',
  MANUAL: 'Manual',
};

const UNKNOWN_CATALOG_CURRENCY = '(moneda del catálogo desconocida)';

/** DX-513-quater: importe con 2 decimales y sin código: no hay moneda que decir. */
function unknownCatalogCurrencyAmount(amount: number): string {
  return `${amountText(amount, 2)} ${UNKNOWN_CATALOG_CURRENCY}`;
}

/**
 * «Precio sin convenio» (DX-513-bis): la base en la moneda del plan si se
 * congeló (`basePriceInPlan`); si no, `basePrice` con SU moneda (la del
 * catálogo), nunca con la del plan. Su moneda va escrita junto al importe
 * cuando no es la del plan.
 */
function baseWithoutAgreementText(row: DiscountReportRowView): string {
  if (row.agreementName === null) return '';
  // DX-513-quater: lista de convenio con la moneda del catálogo desconocida:
  // la cifra es de una moneda que no se sabe, no la del plan.
  if (
    row.agreementUnmeasured &&
    row.catalogCurrency === null &&
    row.basePrice !== null
  ) {
    return unknownCatalogCurrencyAmount(row.basePrice);
  }
  if (row.basePriceInPlan !== null) {
    return csvAmount(row.basePriceInPlan, row.currency);
  }
  if (row.basePrice === null) return '';
  const currency = row.catalogCurrency ?? row.currency;
  const amount = csvAmount(row.basePrice, currency);
  return currency === row.currency ? amount : `${amount} ${currency}`;
}

/** La referencia con la que se midió la rebaja, en la moneda del plan. */
function referenceInPlanText(row: DiscountReportRowView): string {
  if (row.referencePriceInPlan !== null) {
    return csvAmount(row.referencePriceInPlan, row.currency);
  }
  // Ítem anterior sin foto: la referencia cuenta solo en la moneda del plan
  // (o si no se sabe la suya), como en DX-513.
  if (
    row.catalogPrice !== null &&
    (row.referenceCurrency === null || row.referenceCurrency === row.currency)
  ) {
    return csvAmount(row.catalogPrice, row.currency);
  }
  return '';
}

const PLAN_STATUS_LABELS: Record<TreatmentPlanStatus, string> = {
  DRAFT: 'Borrador',
  PRESENTED: 'Presentado',
  ACCEPTED: 'Aceptado',
  REJECTED: 'Rechazado',
  COMPLETED: 'Completado',
  CANCELLED: 'Cancelado',
};

function planLabel(row: DiscountReportRowView): string {
  const created = row.planCreatedOn;
  return row.planOptionLabel
    ? `Plan del ${created} · ${row.planOptionLabel}`
    : `Plan del ${created}`;
}

/**
 * SEC-047: línea que solo tiene rebaja de convenio (sin descuento propio).
 * DX-513-ter: también la de convenio sin medir.
 */
function agreementOnly(row: DiscountReportRowView): boolean {
  return (
    row.discount === 0 &&
    (row.agreementReduction > 0 || row.agreementUnmeasured)
  );
}

/** DX-513-ter: `basePrice` en SU moneda (la del catálogo), con el código. */
function baseInCatalogCurrencyText(row: DiscountReportRowView): string {
  if (row.agreementName === null || row.basePrice === null) return '';
  if (row.catalogCurrency === null)
    return unknownCatalogCurrencyAmount(row.basePrice);
  return `${csvAmount(row.basePrice, row.catalogCurrency)} ${row.catalogCurrency}`;
}

/** DX-513-ter: si la rebaja por convenio se midió; vacío sin convenio. */
function agreementMeasuredText(row: DiscountReportRowView): string {
  if (row.agreementName === null) return '';
  return row.agreementUnmeasured ? 'Sin referencia comparable' : 'Sí';
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
    // DX-513-ter: la tasa del catálogo a la del plan, sea de la referencia o
    // de la base de una lista de convenio.
    const rate = row.rate ?? row.baseRate;
    lines.push(
      [
        row.discountOn,
        text(row.patientName),
        text(planLabel(row)),
        PLAN_STATUS_LABELS[row.planStatus],
        text(row.toothNumber),
        text(row.procedure),
        row.currency,
        row.referenceCurrency ?? '',
        row.catalogPrice === null
          ? ''
          : csvAmount(row.catalogPrice, row.referenceCurrency ?? row.currency),
        referenceInPlanText(row),
        rate ? `${rate.fromPerBase} / ${rate.toPerBase}` : '',
        rate ? RATE_SOURCE_LABELS[rate.source] : '',
        rate?.rateDate ?? '',
        csvAmount(row.price, row.currency),
        csvAmount(row.priceReduction, row.currency),
        csvAmount(row.itemDiscount, row.currency),
        csvAmount(row.discount, row.currency),
        row.percent.toFixed(2),
        reasonText(row),
        text(row.reasonNote),
        authorText(row),
        text(row.locationName),
        text(row.agreementName),
        baseWithoutAgreementText(row),
        // DX-513-ter: sin medir, vacía; nunca «0.00» (no se midió).
        row.agreementUnmeasured
          ? ''
          : csvAmount(row.agreementReduction, row.currency),
        text(row.agreementAssignedByName),
        text(row.createdByName),
        baseInCatalogCurrencyText(row),
        agreementMeasuredText(row),
      ].join(','),
    );
  }
  return csvDocument(lines);
}
