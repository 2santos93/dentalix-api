import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { ToothSurface, TreatmentPlanItemStatus } from '@prisma/client';
import {
  IsMoney,
  MONEY_MAX,
} from '../../../../shared/validation/bounded-decimal';

// All fields optional (partial update: change price/status/surfaces/notes).
// NO `tenantId`/`planId` field — same rationale as UpdateAppointmentDto.
// `surfaces` reuses the odontogram's ToothSurface enum, not a new one.
export class UpdateTreatmentPlanItemDto {
  @ApiPropertyOptional({
    description: 'At most 2 decimal places',
    maximum: MONEY_MAX,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @IsMoney()
  price?: number;

  @ApiPropertyOptional({
    description:
      'Descuento (máx. 2 decimales); nunca mayor que el precio (400). En un plan aceptado con firma: 409',
    maximum: MONEY_MAX,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @IsMoney()
  discount?: number;

  @ApiPropertyOptional({ enum: TreatmentPlanItemStatus })
  @IsOptional()
  @IsEnum(TreatmentPlanItemStatus)
  status?: TreatmentPlanItemStatus;

  @ApiPropertyOptional({ enum: ToothSurface, isArray: true })
  @IsOptional()
  @IsArray()
  @IsEnum(ToothSurface, { each: true })
  surfaces?: ToothSurface[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
