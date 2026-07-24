import { ApiProperty } from '@nestjs/swagger';
import { ToothSurface, TreatmentPlanItemStatus } from '@prisma/client';

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

  @ApiProperty()
  price!: number;

  @ApiProperty({ enum: TreatmentPlanItemStatus })
  status!: TreatmentPlanItemStatus;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}
