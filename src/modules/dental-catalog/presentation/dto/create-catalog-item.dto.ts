import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

// NOTE: deliberately NO `tenantId` field — the tenant comes from the guarded
// request context (JwtAuthGuard -> TenantContextInterceptor), never from the
// client (same convention as CreatePatientDto).
export class CreateCatalogItemDto {
  @ApiProperty({ minLength: 1, description: 'Unique code within the tenant' })
  @IsString()
  @MinLength(1)
  code!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  @ApiProperty({ enum: CatalogKind })
  @IsEnum(CatalogKind)
  kind!: CatalogKind;

  @ApiProperty({ minLength: 1, description: 'Spanish label (required)' })
  @IsString()
  @MinLength(1)
  labelEs!: string;

  @ApiPropertyOptional({ description: 'English label' })
  @IsOptional()
  @IsString()
  labelEn?: string;

  @ApiPropertyOptional({ description: 'Portuguese label' })
  @IsOptional()
  @IsString()
  labelPt?: string;

  @ApiProperty({
    description: 'Hex color (e.g. #1A2B3C)',
    pattern: '^#[0-9a-fA-F]{3,8}$',
  })
  @IsString()
  @Matches(HEX_COLOR_PATTERN, {
    message: 'color must be a valid hex value (e.g. #1A2B3C)',
  })
  color!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  defaultPrice?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
