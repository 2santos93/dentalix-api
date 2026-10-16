import { ToothSurface, TreatmentPlanItemStatus } from '@prisma/client';

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
  status: TreatmentPlanItemStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}
