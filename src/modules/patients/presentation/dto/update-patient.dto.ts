import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { DocType, Sex } from '@prisma/client';

// All fields optional (partial update). NO `tenantId` field — same rationale
// as CreatePatientDto: tenant scoping comes from the guarded request context.
export class UpdatePatientDto {
  @ApiPropertyOptional({ minLength: 1 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  firstName?: string;

  @ApiPropertyOptional({ minLength: 1 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  lastName?: string;

  @ApiPropertyOptional({ enum: DocType })
  @IsOptional()
  @IsEnum(DocType)
  docType?: DocType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  docNumber?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @IsDateString()
  birthDate?: string;

  @ApiPropertyOptional({ enum: Sex })
  @IsOptional()
  @IsEnum(Sex)
  sex?: Sex;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ example: 'CO', description: 'ISO 3166-1 alpha-2' })
  @IsOptional()
  @IsString()
  countryCode?: string;

  @ApiPropertyOptional({
    example: 12345,
    description: 'City id from GET /cities',
  })
  @IsOptional()
  @IsInt()
  cityId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
