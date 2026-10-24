import {
  DiscountReason,
  PriceSource,
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
  visit?: number;
  visitLabel?: string | null;
  id: string;
  tenantId: string;
  planId: string;
  toothNumber: string;
  surfaces: ToothSurface[];
  catalogItemId: string;
  /**
   * SEC-041: precio de REFERENCIA al dar de alta el ítem (null = ítem libre:
   * sin precio). DX-105 (ruling R1): el resuelto (convenio → lista de la sede →
   * catálogo). Un precio por debajo cuenta como descuento discrecional.
   */
  catalogPrice: number | null;
  /**
   * DX-105: foto del precio al dar de alta el ítem, inmutable (nada re-precia):
   * el precio de catálogo de entonces, de dónde salió la referencia, el
   * convenio (id y nombre) y la sede con la que se resolvió. Todo null en los
   * ítems anteriores a DX-105 («sin convenio»).
   */
  basePrice: number | null;
  priceSource: PriceSource | null;
  agreementId: string | null;
  agreementName: string | null;
  pricingLocationId: string | null;
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
  /**
   * DX-050: quién lo realizó (usuario y su nombre), en qué sede (id y nombre)
   * y cuándo (hora del servidor). Todo null fuera de DONE y en los DONE
   * anteriores a DX-050 («Sin atribuir»).
   */
  performedById: string | null;
  performedByName: string | null;
  performedLocationId: string | null;
  performedLocationName: string | null;
  completedAt: Date | null;
  /**
   * SEC-050: el ítem es el cargo VIGENTE (generado y sin anular) por
   * inasistencia o cancelación tardía de esta cita (DX-291). Su precio,
   * descuento y estado no se cambian ni se quita del plan: se anula desde la
   * cita, con motivo. `null` en cualquier otro ítem.
   */
  cancellationFeeAppointmentId: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}
