import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import {
  INPUT_CODE_MAX,
  INPUT_NAME_MAX,
  INPUT_NOTES_MAX,
  TextMaxLength,
} from '../../../../shared/validation/input-limits';
import {
  IsQuantity,
  QUANTITY_MAX,
} from '../../../../shared/validation/bounded-decimal';

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
  @TextMaxLength(INPUT_NAME_MAX)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @TextMaxLength(INPUT_CODE_MAX)
  sku?: string | null;

  @ApiPropertyOptional({ example: 'caja' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @TextMaxLength(INPUT_NAME_MAX)
  unit?: string;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: QUANTITY_MAX,
    example: 1,
    description: 'At most 3 decimal places',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @IsQuantity()
  minStock?: number;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @TextMaxLength(INPUT_NOTES_MAX)
  notes?: string | null;
}
