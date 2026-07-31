import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { DocType, Sex } from '@prisma/client';
import { SaveMedicalHistoryDto } from '../../../medical-history/presentation/dto/save-medical-history.dto';

// NOTE: deliberately NO `tenantId` field — the tenant comes from the guarded
// request context (JwtAuthGuard -> TenantContextInterceptor), never from the client.
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  dataConsentAccepted?: boolean;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @IsDateString()
  dataConsentAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  dataConsentPolicyVersion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  maritalStatus?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  occupation?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  insurerEps?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  physicianName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  physicianPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  emergencyContactName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  emergencyContactRelationship?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  emergencyContactPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  guardianName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  guardianDocNumber?: string;

  @ApiPropertyOptional({ type: SaveMedicalHistoryDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SaveMedicalHistoryDto)
  medicalHistory?: SaveMedicalHistoryDto;
}
