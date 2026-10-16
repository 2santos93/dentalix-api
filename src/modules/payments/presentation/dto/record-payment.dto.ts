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
import {
  IsMoney,
  MONEY_MAX,
} from '../../../../shared/validation/bounded-decimal';

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
  @ApiProperty({
    example: 100,
    description: 'Must be a finite number > 0, with at most 2 decimal places',
    maximum: MONEY_MAX,
  })
  @IsNumber()
  @IsPositive()
  @IsMoney()
  amount!: number;

  @ApiProperty({ example: 'USD', description: 'ISO 4217 currency code' })
  @Transform(toUpperCase)
  @IsISO4217CurrencyCode({
    message: 'currency must be a real ISO 4217 currency code',
  })
  currency!: string;

  @ApiProperty({
    type: String,
    example: '2026-10-16',
    description:
      'Cuándo se pagó el abono: un instante ISO 8601 con hora (p. ej. ' +
      '`2026-10-17T01:00:00.000Z`, que es el 16/10 a las 20:00 en Bogotá) o ' +
      'solo el día civil `YYYY-MM-DD`, que se guarda al mediodía de la zona ' +
      'horaria de la sede del abono (DX-097). La caja y el dashboard lo ' +
      'cuentan en su día civil en la zona de la sede. GET .../balance busca ' +
      'la tasa de cambio por su fecha UTC.',
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
