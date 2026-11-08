import type { FrozenReferenceRate } from '../reference-in-plan';
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
  /**
   * Precio de catálogo al dar de alta el ítem (null = ítem libre), en SU
   * moneda (`referenceCurrency`), que puede no ser la del plan.
   */
  catalogPrice: number | null;
  /**
   * DX-502: moneda de `basePrice` (la del catálogo al dar de alta el ítem);
   * null si no se supo. No es la de `catalogPrice` en un ítem de lista.
   */
  catalogCurrency: string | null;
  /**
   * DX-513-bis: moneda de `catalogPrice` (la congelada o, en un ítem
   * anterior, la de DX-513); null si no se sabe o el ítem es libre.
   */
  referenceCurrency: string | null;
  /**
   * DX-513-bis: `catalogPrice` en la moneda del plan, congelado al escribir
   * el ítem; null en los anteriores sin foto.
   */
  referencePriceInPlan: number | null;
  /** DX-513-bis: `basePrice` en la moneda del plan (con la foto). */
  basePriceInPlan: number | null;
  /**
   * DX-513-bis: la tasa con que se convirtió la referencia; null si no.
   * DX-513-ter: siempre null en las listas (su referencia ya está en la moneda
   * del plan): su tasa, la de la base, va en `baseRate`.
   */
  rate: FrozenReferenceRate | null;
  /**
   * DX-513-ter: en una lista de convenio con el catálogo en otra moneda, la
   * tasa con que se convirtió `basePrice` a `basePriceInPlan` al dar de alta
   * el ítem; null si no.
   */
  baseRate: FrozenReferenceRate | null;
  /**
   * DX-513-ter: ítem de convenio con el catálogo en otra moneda conocida y sin
   * la base congelada en la moneda del plan (no había tasa al darlo de alta,
   * o es anterior): su rebaja de convenio no se puede medir sin convertir al
   * consultar, así que se señala «sin referencia comparable», sin importe.
   */
  agreementUnmeasured: boolean;
  /** Precio pactado del ítem. */
  price: number;
  /**
   * Rebaja de precio frente a la referencia en la moneda del plan (la foto,
   * DX-513-bis); en un ítem anterior sin foto, max(0, catálogo − precio), 0
   * con la referencia en otra moneda conocida (DX-513).
   */
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
   * resuelto por convenio, salvo con el catálogo en otra moneda conocida
   * (DX-513); 0 en el resto. Con foto, max(0, basePriceInPlan −
   * referencePriceInPlan) (DX-513-bis; en las listas de convenio, con la base
   * convertida al darlo de alta, DX-513-ter). 0 si `agreementUnmeasured`.
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
}

/**
 * SEC-047: rebajas de convenio de una moneda, aparte de los totales de
 * DX-204: cuántas líneas y cuánto suman.
 */
export interface AgreementReductionTotal {
  currency: string;
  items: number;
  reduction: number;
}

/**
 * Totales del periodo: los de DX-204 (solo las líneas que cuentan como
 * descuento, iguales que antes de SEC-047), los de la rebaja de convenio y
 * el número de líneas del detalle (paginación).
 */
export interface DiscountReportSummary {
  totals: DiscountReportTotal[];
  agreementTotals: AgreementReductionTotal[];
  /** DX-513-ter: líneas de convenio sin medir, por moneda del plan. */
  agreementUnmeasuredTotals: AgreementUnmeasuredTotal[];
  rows: number;
}

/**
 * DX-513-ter: cuántas líneas de convenio de una moneda no se pudieron medir
 * («sin referencia comparable»). Sin importe: no se convierte al consultar.
 */
export interface AgreementUnmeasuredTotal {
  currency: string;
  items: number;
}

export const DISCOUNT_REPORT_REPOSITORY = Symbol('DISCOUNT_REPORT_REPOSITORY');

export interface DiscountReportRepository {
  /** La sede (viva o retirada) si es de la clínica en contexto; si no, null. */
  findLocation(
    locationId: string,
  ): Promise<{ id: string; name: string } | null>;
  summary(query: DiscountReportQuery): Promise<DiscountReportSummary>;
  /** Filas del periodo, más recientes primero; sin `page`, todas (CSV). */
  rows(
    query: DiscountReportQuery,
    page?: { offset: number; limit: number },
  ): Promise<DiscountReportRow[]>;
}
