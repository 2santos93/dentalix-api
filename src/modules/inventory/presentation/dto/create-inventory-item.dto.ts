import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';

// NOTE: deliberately NO `tenantId`/`createdById` field -- tenant comes from
// the guarded request context (never the client), `createdById` is sourced
// from the authenticated user in the controller (req.user.sub), same
// convention as CreateSaleDto / CreateTreatmentPlanDto.
export class CreateInventoryItemDto {
  @ApiProperty({ example: 'Guantes de nitrilo' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiPropertyOptional({ description: 'Optional item code' })
  @IsOptional()
  @IsString()
  sku?: string;

  @ApiProperty({ example: 'caja', description: 'e.g. "unidad", "caja", "ml"' })
  @IsString()
  @MinLength(1)
  unit!: string;

  @ApiPropertyOptional({ minimum: 0, default: 0, example: 5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minStock?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
