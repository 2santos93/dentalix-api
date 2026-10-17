import type { DiscountReason, TreatmentPlanStatus } from '@prisma/client';

/** Filtros del informe ya validados (DX-204). Días civiles inclusive. */
export interface DiscountReportQuery {
  from: string;
  to: string;
  locationId?: string;
  professionalId?: string;
}

/** Una línea del informe: un ítem vivo con descuento en el periodo. */
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
  price: number;
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
}

/** Suma de una moneda (sin convertir): bruto = precio de esos mismos ítems. */
export interface DiscountReportTotal {
  currency: string;
  items: number;
  gross: number;
  discount: number;
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
