import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
} from 'class-validator';
import { ToothSurface } from '@prisma/client';
import { FDI_TOOTH_NUMBER_PATTERN } from '../../../odontogram/application/use-cases/add-tooth-record.use-case';
import {
  IsMoney,
  MONEY_MAX,
} from '../../../../shared/validation/bounded-decimal';
import { DiscountReasonFieldsDto } from './discount-reason.dto';

// NOTE: deliberately NO `tenantId`/`planId`/`status` field — tenant comes
// from the guarded request context, `planId` from the route param, and a
// newly added item always starts PROPOSED (the schema default, same
// convention as CreateAppointmentDto/CreateToothRecordDto). `toothNumber`/
// `surfaces` reuse the odontogram's exported FDI pattern + ToothSurface enum
// — NOT a new/duplicated regex (see AddToothRecordUseCase /
// CreateToothRecordDto for the identical convention). `price` is optional:
// when omitted, the use case resolves it (DX-105: agreement → location price
// list → catalog `defaultPrice`; 400 if none is available).
export class AddTreatmentPlanItemDto extends DiscountReasonFieldsDto {
  @ApiProperty({
    description:
      'FDI/ISO-3950 tooth code: permanent 11-18/21-28/31-38/41-48, primary 51-55/61-65/71-75/81-85',
    pattern: FDI_TOOTH_NUMBER_PATTERN.source,
    example: '11',
  })
  @IsString()
  @Matches(FDI_TOOTH_NUMBER_PATTERN, {
    message:
      'toothNumber must be a valid FDI code (permanent 11-18/21-28/31-38/41-48 or primary 51-55/61-65/71-75/81-85)',
  })
  toothNumber!: string;

  @ApiPropertyOptional({
    enum: ToothSurface,
    isArray: true,
    description: 'Empty/omitted means the whole tooth (no specific surface)',
  })
  @IsOptional()
  @IsArray()
  @IsEnum(ToothSurface, { each: true })
  surfaces?: ToothSurface[];

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  catalogItemId!: string;

  @ApiPropertyOptional({
    description:
      'Precio explícito (máx. 2 decimales). Si se omite, la API lo resuelve (DX-105): convenio vigente del paciente → lista de precios activa de la sede → precio de catálogo; sin ninguno, 400. El resuelto queda como referencia (`catalogPrice`): un precio por debajo cuenta como descuento (tope del rol y motivo de la política) y, si la prestación no admite descuentos, 400',
    maximum: MONEY_MAX,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @IsMoney()
  price?: number;

  @ApiPropertyOptional({
    description:
      'Descuento en la moneda del plan (máx. 2 decimales, default 0); nunca mayor que el precio (400). DX-204: por encima del tope del rol, 403; en un plan aceptado, 409',
    maximum: MONEY_MAX,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @IsMoney()
  discount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
