import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

// NOTE: deliberately NO `amount` field here -- `amount` (`unitPrice *
// quantity`) is DERIVED by CreateSaleUseCase, never accepted from the
// client (same convention as the port's CreateSaleLineItemRepoInput /
// AddTreatmentPlanItemUseCase resolving `price` before the repo call).
export class CreateSaleLineItemDto {
  @ApiProperty({ description: 'Free-text description of the line item' })
  @IsString()
  description!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Optional link to a dental catalog item',
  })
  @IsOptional()
  @IsUUID()
  catalogItemId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Optional link to a treatment plan item',
  })
  @IsOptional()
  @IsUUID()
  treatmentPlanItemId?: string;

  @ApiProperty({ minimum: 0, example: 50000 })
  @IsNumber()
  @Min(0)
  unitPrice!: number;

  @ApiProperty({ minimum: 1, example: 1 })
  @IsInt()
  @Min(1)
  quantity!: number;
}
