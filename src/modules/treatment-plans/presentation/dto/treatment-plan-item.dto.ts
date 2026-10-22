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
    enum: PriceSource,
    nullable: true,
    description:
      'DX-105: de dónde salió `catalogPrice` (convenio por %, lista del convenio, lista de la sede o catálogo). Null en ítems anteriores a DX-105.',
  })
  priceSource!: PriceSource | null;

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

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}
