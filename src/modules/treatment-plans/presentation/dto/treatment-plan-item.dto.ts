import { ApiProperty } from '@nestjs/swagger';
import {
  DiscountReason,
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
      'SEC-041: precio de catálogo al dar de alta el ítem (null = ítem libre). Un precio por debajo cuenta como descuento: tope del rol, motivo e informe de descuentos.',
  })
  catalogPrice!: number | null;

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
