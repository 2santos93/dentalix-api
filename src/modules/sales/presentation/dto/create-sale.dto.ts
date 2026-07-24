import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { PaymentMethod } from '@prisma/client';
import { CreateSaleLineItemDto } from './create-sale-line-item.dto';

// Uppercase-normalizes ISO 4217 codes, same convention as ConvertQueryDto
// (exchange module) -- snapshots/rates are always looked up uppercase, so
// this keeps `currency=cop` behaving the same as `currency=COP`.
function toUpperCase({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.toUpperCase() : value;
}

// NOTE: deliberately NO `tenantId`/`total`/`createdById` field -- tenant
// comes from the guarded request context (never the client); `total` is
// DERIVED by CreateSaleUseCase from the line items (Sigma amount), never
// accepted from the caller; `createdById` is sourced from the authenticated
// user in the controller (req.user.sub), same convention as
// AppointmentsController.create / TreatmentPlansController.create.
export class CreateSaleDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  patientId?: string;

  @ApiProperty({ example: 'COP', description: 'ISO 4217 currency code' })
  @Transform(toUpperCase)
  @IsString()
  currency!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'When the payment was made. Its calendar date (UTC) is what GET /sales/totals uses to look up the exchange rate for this sale.',
  })
  @IsDateString()
  paidAt!: string;

  @ApiPropertyOptional({ enum: PaymentMethod })
  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiProperty({ type: [CreateSaleLineItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateSaleLineItemDto)
  lineItems!: CreateSaleLineItemDto[];
}
