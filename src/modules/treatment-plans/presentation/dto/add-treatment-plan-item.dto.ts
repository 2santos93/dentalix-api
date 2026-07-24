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

// NOTE: deliberately NO `tenantId`/`planId`/`status` field — tenant comes
// from the guarded request context, `planId` from the route param, and a
// newly added item always starts PROPOSED (the schema default, same
// convention as CreateAppointmentDto/CreateToothRecordDto). `toothNumber`/
// `surfaces` reuse the odontogram's exported FDI pattern + ToothSurface enum
// — NOT a new/duplicated regex (see AddToothRecordUseCase /
// CreateToothRecordDto for the identical convention). `price` is optional:
// when omitted, the use case resolves it from the catalog item's
// `defaultPrice` (400 if neither is available).
export class AddTreatmentPlanItemDto {
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
      'Explicit price; if omitted, falls back to the catalog item defaultPrice (400 if neither is set)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
