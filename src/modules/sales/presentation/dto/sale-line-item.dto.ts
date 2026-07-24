import { ApiProperty } from '@nestjs/swagger';

// Response shape for a SaleLineItem, embedded in SaleDto -- documents the
// SaleLineItem entity contract for Swagger (same convention as
// TreatmentPlanItemDto: exists purely for `@ApiProperty` docs, not input
// validation). Deliberately NO `tenantId` (see SaleDto for the same call --
// Task 3 explicitly keeps tenantId off every sales DTO, unlike
// AppointmentDto/TreatmentPlanDto which document it).
export class SaleLineItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  saleId!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  catalogItemId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  treatmentPlanItemId!: string | null;

  @ApiProperty({ example: 50000 })
  unitPrice!: number;

  @ApiProperty({ example: 1 })
  quantity!: number;

  @ApiProperty({ example: 50000 })
  amount!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}
