import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { DocType, Sex } from '@prisma/client';

/**
 * Para columnas NOT NULL. `@IsOptional()` no sirve: saltea TODOS los
 * validadores cuando el valor es `null` o `undefined`, así que un
 * `firstName: null` pasaba la validación, llegaba a Prisma y reventaba la
 * restricción NOT NULL como un 500 genérico. Esto valida sólo cuando la clave
 * viene presente: ausente = no se toca, `null` = falla con 400.
 */
function NotNullable(): PropertyDecorator {
  return ValidateIf((_object: unknown, value: unknown) => value !== undefined);
}

// All fields optional (partial update). NO `tenantId` field — same rationale
// as CreatePatientDto: tenant scoping comes from the guarded request context.
// Los campos de columnas nullable se declaran `nullable: true` para que el
// cliente generado los tipe `string | null` y pueda VACIARLOS sin castear.
export class UpdatePatientDto {
  @ApiPropertyOptional({ minLength: 1 })
  @NotNullable()
  @IsString()
  @MinLength(1)
  firstName?: string;

  @ApiPropertyOptional({ minLength: 1 })
  @NotNullable()
  @IsString()
  @MinLength(1)
  lastName?: string;

  @ApiPropertyOptional({ enum: DocType })
  @NotNullable()
  @IsEnum(DocType)
  docType?: DocType;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  docNumber?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  @IsOptional()
  @IsDateString()
  birthDate?: string;

  @ApiPropertyOptional({ enum: Sex })
  @NotNullable()
  @IsEnum(Sex)
  sex?: Sex;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({
    example: 'CO',
    description: 'ISO 3166-1 alpha-2',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  countryCode?: string;

  @ApiPropertyOptional({
    example: 12345,
    description: 'City id from GET /cities',
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  cityId?: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;

  // Administrativos: `CreatePatientDto` ya los acepta, pero hasta ahora no se
  // podían corregir — el PATCH los descartaba. El consentimiento queda FUERA a
  // propósito: es un hecho fechado, no un dato editable.
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  maritalStatus?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  occupation?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  insurerEps?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  physicianName?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  physicianPhone?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  emergencyContactName?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  emergencyContactRelationship?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  emergencyContactPhone?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  guardianName?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  guardianDocNumber?: string;
}
