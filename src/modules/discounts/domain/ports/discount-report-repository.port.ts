import type {
  DiscountReason,
  PriceSource,
  TreatmentPlanStatus,
} from '@prisma/client';

/** Filtros del informe ya validados (DX-204). Días civiles inclusive. */
export interface DiscountReportQuery {
  from: string;
  to: string;
  locationId?: string;
  professionalId?: string;
}

/**
 * Una línea del informe: un ítem vivo con descuento en el periodo. SEC-041: el
 * descuento es el EFECTIVO, la rebaja del precio frente al de catálogo más el
 * `discount` del ítem. SEC-047: también los ítems resueltos por convenio con
 * rebaja, aunque no tengan descuento propio; la rebaja de convenio va APARTE
 * (`agreementReduction`), no suma en `discount`.
 */
export interface DiscountReportRow {
  itemId: string;
  planId: string;
  planStatus: TreatmentPlanStatus;
  planOptionLabel: string | null;
  planCreatedAt: Date;
  /** Día civil de alta del plan en la zona de la sede del descuento. */
  planCreatedOn: string;
  patientId: string;
  patientName: string;
  toothNumber: string;
  procedure: string;
  currency: string;
  /** Precio de catálogo al dar de alta el ítem (null = ítem libre). */
  catalogPrice: number | null;
  /** Precio pactado del ítem. */
  price: number;
  /** Rebaja de precio frente al catálogo: max(0, catálogo − precio). */
  priceReduction: number;
  /** El `discount` del ítem. */
  itemDiscount: number;
  /** Descuento total: rebaja de precio + descuento del ítem. */
  discount: number;
  reason: DiscountReason | null;
  reasonNote: string | null;
  discountById: string | null;
  discountByName: string | null;
  /** Hora del descuento; en los anteriores a DX-204, la de alta del ítem. */
  discountAt: Date;
  /** Día civil del descuento en la zona de su sede (la por defecto, sin sede). */
  discountOn: string;
  locationId: string | null;
  locationName: string | null;
  /** DX-105: origen del precio de referencia (null = ítem anterior a DX-105). */
  priceSource: PriceSource | null;
  /** Convenio con el que se resolvió el precio (foto del alta). */
  agreementName: string | null;
  /** DX-105: precio de catálogo al dar de alta el ítem (sin convenio). */
  basePrice: number | null;
  /**
   * SEC-047: rebaja de convenio, max(0, basePrice − catalogPrice) en un ítem
   * resuelto por convenio; 0 en el resto.
   */
  agreementReduction: number;
  /**
   * SEC-047: quién asignó el convenio al paciente (la asignación de ese
   * convenio vigente al dar de alta el ítem); null sin convenio.
   */
  agreementAssignedById: string | null;
  agreementAssignedByName: string | null;
  /** SEC-047: quién dio de alta el ítem; null en los anteriores a SEC-047. */
  createdById: string | null;
  createdByName: string | null;
}

/**
 * Suma de una moneda (sin convertir). Bruto = precio de referencia de esos
 * mismos ítems (el de catálogo si se rebajó; si no, el precio); descuento =
 * rebajas de precio + descuentos (SEC-041).
 */
export interface DiscountReportTotal {
  currency: string;
  items: number;
  gross: number;
  discount: number;
  /** SEC-047: suma de las rebajas de convenio (aparte del descuento). */
  agreementReduction: number;
}

export const DISCOUNT_REPORT_REPOSITORY = Symbol('DISCOUNT_REPORT_REPOSITORY');

export interface DiscountReportRepository {
  /** La sede (viva o retirada) si es de la clínica en contexto; si no, null. */
  findLocation(
    locationId: string,
  ): Promise<{ id: string; name: string } | null>;
  totals(query: DiscountReportQuery): Promise<DiscountReportTotal[]>;
  /** Filas del periodo, más recientes primero; sin `page`, todas (CSV). */
  rows(
    query: DiscountReportQuery,
    page?: { offset: number; limit: number },
  ): Promise<DiscountReportRow[]>;
}
