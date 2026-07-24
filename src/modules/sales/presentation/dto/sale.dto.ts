import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import { SaleLineItemDto } from './sale-line-item.dto';

// Response shape for Sale endpoints -- documents the Sale/SaleWithLineItems
// entity contracts for Swagger (same convention as AppointmentDto /
// TreatmentPlanDto: exists purely for `@ApiProperty` docs, not input
// validation). Deliberately NO `tenantId` field -- unlike
// AppointmentDto/TreatmentPlanDto (which document tenantId on their entity),
// Task 3 explicitly keeps it off every sales-facing DTO; the tenant is an
// internal RLS concern here, never something the client needs echoed back.
// `lineItems` is only populated by POST /sales and GET /sales/:id (see
// CreateSaleUseCase / GetSaleUseCase) -- GET /sales (list) returns bare
// sales, so the field is optional here (same pattern as
// TreatmentPlanDto.items).
export class SaleDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  patientId!: string | null;

  @ApiProperty({ example: 'COP', description: 'ISO 4217 currency code' })
  currency!: string;

  @ApiProperty({
    example: 150000,
    description: 'Stored, immutable sum of active line item amounts.',
  })
  total!: number;

  @ApiProperty({ format: 'date-time' })
  paidAt!: Date;

  @ApiProperty({ enum: PaymentMethod, nullable: true })
  paymentMethod!: PaymentMethod | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;

  @ApiPropertyOptional({ type: [SaleLineItemDto] })
  lineItems?: SaleLineItemDto[];
}
