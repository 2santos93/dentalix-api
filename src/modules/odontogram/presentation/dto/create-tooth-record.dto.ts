import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';
import { CatalogKind, ToothRecordStatus, ToothSurface } from '@prisma/client';
import { FDI_TOOTH_NUMBER_PATTERN } from '../../application/use-cases/add-tooth-record.use-case';

// NOTE: deliberately NO `tenantId`/`patientId`/`performedById` field — tenant
// comes from the guarded request context, `patientId` from the route param,
// and `performedById` from `req.user.sub` (same convention as
// CreateClinicalEntryDto / CreateCatalogItemDto). `status` is validated here
// against the enum (per code review of Task 2 — the use case forwards it
// as given, so the DTO boundary is what actually rejects a bad value).
export class CreateToothRecordDto {
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

  @ApiProperty({ enum: CatalogKind })
  @IsEnum(CatalogKind)
  kind!: CatalogKind;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  catalogItemId?: string;

  @ApiPropertyOptional({
    enum: ToothRecordStatus,
    default: ToothRecordStatus.COMPLETED,
  })
  @IsOptional()
  @IsEnum(ToothRecordStatus)
  status?: ToothRecordStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  clinicalEntryId?: string;
}
