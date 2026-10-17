import {
  DiscountReason,
  ToothSurface,
  TreatmentPlanItemStatus,
} from '@prisma/client';

/**
 * API-facing shape of a TreatmentPlanItem. Deliberately NOT the raw Prisma
 * model: repositories must `mapToEntity` before returning across the port
 * boundary (same convention as Appointment / DentalCatalogItem). `price` is a
 * plain `number` here (Prisma returns `Decimal` — see
 * `PrismaDentalCatalogRepository.mapToEntity` for the identical convention on
 * `defaultPrice`).
 */
export interface TreatmentPlanItem {
  id: string;
  tenantId: string;
  planId: string;
  toothNumber: string;
  surfaces: ToothSurface[];
  catalogItemId: string;
  price: number;
  /** Descuento del ítem en la moneda del plan (DX-012); 0 ≤ discount ≤ price. */
  discount: number;
  /**
   * DX-204: motivo (catálogo) y nota del descuento vigente, quién lo dio,
   * cuándo y en qué sede. Todo null sin descuento (y en los anteriores a
   * DX-204).
   */
  discountReason: DiscountReason | null;
  discountReasonNote: string | null;
  discountById: string | null;
  discountAt: Date | null;
  discountLocationId: string | null;
  status: TreatmentPlanItemStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}
