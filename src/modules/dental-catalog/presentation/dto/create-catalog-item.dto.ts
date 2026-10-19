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
import { HEX_COLOR_PATTERN } from '../../application/use-cases/create-catalog-item.use-case';
import {
  IsMoney,
  MONEY_MAX,
} from '../../../../shared/validation/bounded-decimal';

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
    pattern: HEX_COLOR_PATTERN.source,
  })
  @IsString()
  @Matches(HEX_COLOR_PATTERN, {
    message: 'color must be a valid hex value (e.g. #1A2B3C)',
  })
  color!: string;

  @ApiPropertyOptional({
    description: 'At most 2 decimal places',
    maximum: MONEY_MAX,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @IsMoney()
  defaultPrice?: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '890203',
    description:
      'DX-212: código CUPS del procedimiento, 6 caracteres alfanuméricos (400 con el formato esperado si no). Vacío o null lo quita. Solo ADMIN.',
  })
  @IsOptional()
  @IsString()
  cupsCode?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
