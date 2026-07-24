import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';

// All fields optional (partial update). `sku`/`notes` accept `null` to
// clear the field -- `@IsOptional()` skips validation for both `undefined`
// and `null` (class-validator convention), same as
// UpdateTreatmentPlanItemDto's nullable fields. NO `tenantId` field -- same
// rationale as UpdateTreatmentPlanDto/UpdateSaleDto.
export class UpdateInventoryItemDto {
  @ApiPropertyOptional({ example: 'Guantes de nitrilo' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  sku?: string | null;

  @ApiPropertyOptional({ example: 'caja' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  unit?: string;

  @ApiPropertyOptional({ minimum: 0, example: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minStock?: number;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  notes?: string | null;
}
