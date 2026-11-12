import {
  DiscountReason,
  PriceSource,
  ToothSurface,
  TreatmentPlanItemStatus,
} from '@prisma/client';
import type { FrozenReferenceRate } from '../../../discounts/domain/reference-in-plan';

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
  /**
   * DX-502: moneda de `basePrice` (la del catálogo, común a las sedes activas,
   * al dar de alta el ítem); null si no se supo. No es la del plan por fuerza.
   */
  catalogCurrency: string | null;
  priceSource: PriceSource | null;
  /**
   * DX-513-bis: foto de la referencia en la moneda del plan, escrita una vez
   * (al dar de alta el ítem o, en uno anterior, en su primera rebaja). La
   * moneda de `catalogPrice` (null si no se supo), `catalogPrice` y
   * `basePrice` en la moneda del plan y, si se convirtió, la tasa. Todo null
   * en los ítems anteriores sin foto y en los libres. El tope, el motivo y el
   * informe miden la rebaja frente a `referencePriceInPlan`.
   *
   * DX-513-ter: la tasa va en `referenceRate` si se aplicó a la referencia
   * (catálogo o % de convenio) y en `baseRate` si es la de la base de una
   * lista de convenio (la referencia ya estaba en la moneda del plan).
   */
  referenceCurrency: string | null;
  referencePriceInPlan: number | null;
  basePriceInPlan: number | null;
  referenceRate: FrozenReferenceRate | null;
  baseRate: FrozenReferenceRate | null;
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

/**
 * DX-015-bis: un recall que movió el cambio del ítem (DONE, salida de DONE o
 * corrección de fecha o sede de un procedimiento disparador).
 */
export interface ItemRecallUpdate {
  recallId: string;
  recallTypeId: string;
  recallTypeName: string;
  /** Vencimiento tras el cambio (día civil). */
  dueAt: string;
  /**
   * D9: la exclusión lo desactivó porque otro recall de un tipo del mismo
   * grupo pasó a activo con este cambio.
   */
  deactivated: boolean;
  /** El tipo del recall que lo sustituye; null si no se desactivó. */
  replacedBy: { recallTypeId: string; recallTypeName: string } | null;
}

/** DX-015-bis: lo que devuelve el PATCH del ítem. */
export interface TreatmentPlanItemUpdate extends TreatmentPlanItem {
  /** Vacío si el procedimiento no dispara ningún tipo de recall. */
  recallUpdates: ItemRecallUpdate[];
}
