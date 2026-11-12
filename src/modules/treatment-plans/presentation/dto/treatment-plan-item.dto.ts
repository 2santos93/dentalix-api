import { ReferenceRateDto } from '../../../discounts/presentation/dto/reference-rate.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DiscountReason,
  PriceSource,
  ToothSurface,
  TreatmentPlanItemStatus,
} from '@prisma/client';

// Response shape for TreatmentPlanItem — documents the TreatmentPlanItem
// entity contract for Swagger (same convention as AppointmentDto /
// DentalCatalogItemDto). The use cases already return values shaped exactly
// like this (see ../../domain/entities/treatment-plan-item.entity.ts); this
// class exists purely for `@ApiProperty` documentation, not for input
// validation.
export class TreatmentPlanItemDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  visit!: number;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 60 })
  visitLabel!: string | null;
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  planId!: string;

  @ApiProperty()
  toothNumber!: string;

  @ApiProperty({ enum: ToothSurface, isArray: true })
  surfaces!: ToothSurface[];

  @ApiProperty({ format: 'uuid' })
  catalogItemId!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Precio de REFERENCIA al dar de alta el ítem (null = ítem libre). DX-105: el resuelto (convenio → lista de precios de la sede → catálogo). Un precio por debajo cuenta como descuento (SEC-041): tope del rol, motivo e informe de descuentos.',
  })
  catalogPrice!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'DX-105: precio de catálogo (`defaultPrice`) en el alta. Null en ítems anteriores a DX-105 o sin precio de catálogo.',
  })
  basePrice!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'DX-502: moneda de `basePrice`, la del catálogo (común a las sedes activas) al dar de alta el ítem, congelada. Null si no había una común o no hay precio de catálogo. Puede no ser la del plan: no se convierte.',
  })
  catalogCurrency!: string | null;

  @ApiProperty({
    enum: PriceSource,
    nullable: true,
    description:
      'DX-105: de dónde salió `catalogPrice` (convenio por %, lista del convenio, lista de la sede o catálogo). Null en ítems anteriores a DX-105.',
  })
  priceSource!: PriceSource | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'DX-513-bis: moneda de `catalogPrice` al escribir el ítem (la del plan para las listas, la del catálogo para el resto). Null si no se supo, en los libres y en los anteriores sin foto.',
  })
  referenceCurrency!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'DX-513-bis: `catalogPrice` en la moneda del plan, congelado al escribir el ítem (convertido con `referenceRate` si su moneda era otra). Es la referencia del descuento: un precio por debajo cuenta (tope por rol y motivo). Null en los libres y en los anteriores sin foto (se miden como en DX-513).',
  })
  referencePriceInPlan!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'DX-513-bis: `basePrice` en la moneda del plan, congelado con la referencia. DX-513-ter: en una lista de convenio con el catálogo en otra moneda, convertido con `baseRate`. Null si no hay o no había tasa para expresarlo.',
  })
  basePriceInPlan!: number | null;

  @ApiProperty({
    type: () => ReferenceRateDto,
    nullable: true,
    description:
      'DX-513-bis: la tasa (de la moneda del catálogo a la del plan) con que se convirtió la referencia (`catalogPrice` en `referenceCurrency`); null si no hizo falta. DX-513-ter: siempre null en las listas (`PRICE_LIST`, `AGREEMENT_PRICE_LIST`), cuya referencia ya está en la moneda del plan: su tasa va en `baseRate`.',
  })
  referenceRate!: ReferenceRateDto | null;

  @ApiProperty({
    type: () => ReferenceRateDto,
    nullable: true,
    description:
      'DX-513-ter: en un ítem de lista de convenio con el catálogo en otra moneda, la tasa del día (de `catalogCurrency` a la del plan) con que se convirtió `basePrice` a `basePriceInPlan`, congelada al darlo de alta. Null si no hizo falta, si no había tasa ese día o si el ítem no es de lista.',
  })
  baseRate!: ReferenceRateDto | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'DX-105: convenio con el que se resolvió el precio',
  })
  agreementId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'DX-105: nombre del convenio en el alta (foto: no cambia si se renombra)',
  })
  agreementName!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'DX-105: sede con la que se resolvió el precio',
  })
  pricingLocationId!: string | null;

  @ApiProperty()
  price!: number;

  @ApiProperty({ description: 'Descuento en la moneda del plan (0 si no hay)' })
  discount!: number;

  @ApiProperty({
    enum: DiscountReason,
    nullable: true,
    description: 'DX-204: motivo del descuento vigente',
  })
  discountReason!: DiscountReason | null;

  @ApiProperty({ type: String, nullable: true })
  discountReasonNote!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'DX-204: quién dio el descuento vigente, incluida la rebaja de precio frente al catálogo (SEC-041); null sin descuento o anterior a DX-204',
  })
  discountById!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'DX-204: cuándo (hora del servidor)',
  })
  discountAt!: Date | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'DX-204: sede donde se dio (la activa o la principal)',
  })
  discountLocationId!: string | null;

  @ApiProperty({ enum: TreatmentPlanItemStatus })
  status!: TreatmentPlanItemStatus;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'DX-050: usuario que realizó el procedimiento. Null fuera de DONE y en los DONE anteriores a DX-050 («Sin atribuir»)',
  })
  performedById!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'DX-050: su nombre (también si ya no es miembro activo de la clínica)',
  })
  performedByName!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'DX-050: sede donde se realizó (la del request al marcarlo)',
  })
  performedLocationId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'DX-050: su nombre',
  })
  performedLocationName!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'DX-050: cuándo se realizó (hora del servidor al marcarlo)',
  })
  completedAt!: Date | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'SEC-050: el ítem es el cargo vigente por inasistencia o cancelación tardía de esta cita (DX-291). Su precio, descuento y estado no cambian ni se quita del plan (409 a todo rol): se anula con `POST /appointments/{id}/cancellation-fee/void`, con motivo. null en cualquier otro ítem.',
  })
  cancellationFeeAppointmentId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

/** DX-015-bis: un recall que movió el cambio del ítem. */
export class ItemRecallUpdateDto {
  @ApiProperty({ format: 'uuid' })
  recallId!: string;
  @ApiProperty({ format: 'uuid' })
  recallTypeId!: string;
  @ApiProperty({ example: 'Higiene' })
  recallTypeName!: string;
  @ApiProperty({
    format: 'date',
    example: '2027-10-10',
    description: 'Vencimiento del recall tras el cambio (día civil)',
  })
  dueAt!: string;
}

/** DX-015-bis: respuesta del PATCH del ítem (el ítem y los recalls que movió). */
export class UpdatedTreatmentPlanItemDto extends TreatmentPlanItemDto {
  @ApiProperty({
    type: [ItemRecallUpdateDto],
    description:
      'Recalls que creó o recalculó el cambio (DONE, salida de DONE o corrección de fecha o sede de un procedimiento disparador); vacío si ninguno',
  })
  recallUpdates!: ItemRecallUpdateDto[];
}
