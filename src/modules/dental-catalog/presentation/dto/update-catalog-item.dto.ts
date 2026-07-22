import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
  MinLength,
} from 'class-validator';
import { CatalogKind } from '@prisma/client';

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/;

// All fields optional (partial update). NO `tenantId` field — same rationale
// as CreateCatalogItemDto: tenant scoping comes from the guarded request context.
export class UpdateCatalogItemDto {
  @ApiPropertyOptional({ minLength: 1 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ enum: CatalogKind })
  @IsOptional()
  @IsEnum(CatalogKind)
  kind?: CatalogKind;

  @ApiPropertyOptional({ minLength: 1 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  labelEs?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  labelEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  labelPt?: string;

  @ApiPropertyOptional({
    description: 'Hex color (e.g. #1A2B3C)',
    pattern: '^#[0-9a-fA-F]{3,8}$',
  })
  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_PATTERN, {
    message: 'color must be a valid hex value (e.g. #1A2B3C)',
  })
  color?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  defaultPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
