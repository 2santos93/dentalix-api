import { ApiProperty } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';

// Response shape for Payment endpoints -- documents the Payment entity
// contract for Swagger (same convention as AppointmentDto / SaleDto: exists
// purely for `@ApiProperty` docs, not input validation). The use cases
// already return values shaped exactly like this (Payment entity, see
// ../../domain/entities/payment.entity.ts).
export class PaymentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ format: 'uuid' })
  treatmentPlanId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ example: 100 })
  amount!: number;

  @ApiProperty({ example: 'USD', description: 'ISO 4217 currency code' })
  currency!: string;

  @ApiProperty({ format: 'date-time' })
  paidAt!: Date;

  @ApiProperty({ enum: PaymentMethod, nullable: true })
  method!: PaymentMethod | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}
