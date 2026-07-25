import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsISO4217CurrencyCode,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';
import { PaymentMethod } from '@prisma/client';

// Uppercase-normalizes ISO 4217 codes, same convention as ConvertQueryDto
// (exchange module) / the deleted CreateSaleDto -- snapshots/rates are always
// looked up uppercase, so this keeps `currency=cop` behaving the same as
// `currency=COP`.
function toUpperCase({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.toUpperCase() : value;
}

// NOTE: deliberately NO `tenantId`/`treatmentPlanId`/`createdById` field --
// tenant comes from the guarded request context (never the client),
// `treatmentPlanId` from the route param (`:id`), and `createdById` is
// sourced from the authenticated user in the controller (req.user.sub),
// never from the client body -- same convention as
// AppointmentsController.create / the deleted CreateSaleDto.
export class RecordPaymentDto {
  @ApiProperty({ example: 100, description: 'Must be a finite number > 0' })
  @IsNumber()
  @IsPositive()
  amount!: number;

  @ApiProperty({ example: 'USD', description: 'ISO 4217 currency code' })
  @Transform(toUpperCase)
  @IsISO4217CurrencyCode({
    message: 'currency must be a real ISO 4217 currency code',
  })
  currency!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'When the abono was paid. Its calendar date (UTC) is what GET .../balance uses to look up the exchange rate when this currency differs from the plan currency.',
  })
  @IsDateString()
  paidAt!: string;

  @ApiPropertyOptional({ enum: PaymentMethod })
  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
