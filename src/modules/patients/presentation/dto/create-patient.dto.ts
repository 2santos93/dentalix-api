import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { DocType, Sex } from '@prisma/client';

// NOTE: deliberately NO `tenantId` field — the tenant comes from the guarded
// request context (JwtAuthGuard -> TenantContextGuard), never from the client.
export class CreatePatientDto {
  @ApiProperty({ minLength: 1 })
  @IsString()
  @MinLength(1)
  firstName!: string;

  @ApiProperty({ minLength: 1 })
  @IsString()
  @MinLength(1)
  lastName!: string;

  @ApiProperty({ enum: DocType })
  @IsEnum(DocType)
  docType!: DocType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  docNumber?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @IsDateString()
  birthDate?: string;

  @ApiProperty({ enum: Sex })
  @IsEnum(Sex)
  sex!: Sex;

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
