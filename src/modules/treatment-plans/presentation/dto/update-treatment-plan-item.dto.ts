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

// All fields optional (partial update: change price/status/surfaces/notes).
// NO `tenantId`/`planId` field — same rationale as UpdateAppointmentDto.
// `surfaces` reuses the odontogram's ToothSurface enum, not a new one.
export class UpdateTreatmentPlanItemDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

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
