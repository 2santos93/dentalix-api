/**
 * API-facing shape of a SaleLineItem. Deliberately NOT the raw Prisma model:
 * repositories must `mapToEntity` before returning across the port boundary
 * (same convention as TreatmentPlanItem / DentalCatalogItem). `unitPrice` and
 * `amount` are plain `number` here (Prisma returns `Decimal`).
 *
 * Note there is no `deletedAt` on this entity — unlike TreatmentPlanItem,
 * line items are never individually soft-deleted: a sale is voided as a
 * whole (`Sale.deletedAt`), never one of its lines. The schema mirrors this
 * (`SaleLineItem` has no `deletedAt` column at all).
 */
export interface SaleLineItem {
  id: string;
  tenantId: string;
  saleId: string;
  description: string;
  catalogItemId: string | null;
  treatmentPlanItemId: string | null;
  unitPrice: number;
  quantity: number;
  amount: number;
  createdAt: Date;
  updatedAt: Date;
}
