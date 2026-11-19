import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
  ValidateIf,
  IsUUID,
} from 'class-validator';
import {
  INPUT_CODE_MAX,
  INPUT_NAME_MAX,
  INPUT_NOTES_MAX,
  INPUT_SHORT_TEXT_MAX,
  TextMaxLength,
} from '../../../../shared/validation/input-limits';
import { Sex } from '@prisma/client';
import { REFERRED_BY_NAME_MAX } from '../../domain/patient-acquisition';
import { DOCUMENT_TYPES } from '../../domain/document-type';
import {
  DOC_TYPE_INPUTS,
  DOC_TYPE_LABEL_PROPERTY,
  DOC_TYPE_MESSAGE,
  type DocTypeInput,
} from './doc-type-input';

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
  @TextMaxLength(INPUT_NAME_MAX)
  firstName?: string;

  @ApiPropertyOptional({ minLength: 1 })
  @NotNullable()
  @IsString()
  @MinLength(1)
  @TextMaxLength(INPUT_NAME_MAX)
  lastName?: string;

  @ApiPropertyOptional({ enum: DOCUMENT_TYPES, enumName: 'DocType' })
  @NotNullable()
  @IsIn(DOC_TYPE_INPUTS, { message: DOC_TYPE_MESSAGE })
  docType?: DocTypeInput;

  // DX-327 (R7): ausente = no se toca, salvo que cambie el tipo (entonces se
  // borra); null o vacío = sin nombre propio.
  @ApiPropertyOptional(DOC_TYPE_LABEL_PROPERTY)
  @IsOptional()
  @IsString({ message: 'docTypeLabel debe ser un texto.' })
  @TextMaxLength(INPUT_CODE_MAX)
  docTypeLabel?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @TextMaxLength(INPUT_CODE_MAX)
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
  @TextMaxLength(INPUT_CODE_MAX)
  phone?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @TextMaxLength(INPUT_SHORT_TEXT_MAX)
  address?: string;

  @ApiPropertyOptional({
    example: 'VE',
    description: 'ISO 3166-1 alpha-2',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @TextMaxLength(INPUT_CODE_MAX)
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
  @TextMaxLength(INPUT_NOTES_MAX)
  notes?: string;

  // Administrativos: `CreatePatientDto` ya los acepta, pero hasta ahora no se
  // podían corregir — el PATCH los descartaba. El consentimiento queda FUERA a
  // propósito: es un hecho fechado, no un dato editable.
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @TextMaxLength(INPUT_NAME_MAX)
  maritalStatus?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @TextMaxLength(INPUT_SHORT_TEXT_MAX)
  occupation?: string;

  // DX-153/DX-322: el texto libre de aseguradora anterior a DX-153 ya no se
  // lee ni se escribe (la ValidationPipe lo descarta); la aseguradora se
  // registra en `/patients/:id/coverages`.

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @TextMaxLength(INPUT_NAME_MAX)
  physicianName?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @TextMaxLength(INPUT_CODE_MAX)
  physicianPhone?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @TextMaxLength(INPUT_NAME_MAX)
  emergencyContactName?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @TextMaxLength(INPUT_NAME_MAX)
  emergencyContactRelationship?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @TextMaxLength(INPUT_CODE_MAX)
  emergencyContactPhone?: string;

  // DX-203: guardianName/guardianDocNumber son de solo lectura (DEPRECADO):
  // el tutor se gestiona como responsable. Si llegan, se descartan.

  // DX-172: «¿Cómo nos conoció?». Dato personal: solo el personal de la clínica.
  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'DX-172: fuente del catálogo de la clínica (`GET /patient-sources`). Opcional; al asignarla tiene que estar activa. `null` la vacía (y con ella el referente).',
  })
  @IsOptional()
  @IsUUID()
  sourceId?: string | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'DX-172: el paciente de la clínica que lo recomendó. Solo con una fuente de tipo PATIENT; nunca el propio paciente. De otra clínica: 400.',
  })
  @IsOptional()
  @IsUUID()
  referredByPatientId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: REFERRED_BY_NAME_MAX,
    description:
      'DX-172: nombre del profesional externo que lo derivó (1–120). Solo con una fuente de tipo EXTERNAL_PROFESSIONAL.',
  })
  @IsOptional()
  @IsString()
  @TextMaxLength(REFERRED_BY_NAME_MAX)
  referredByName?: string | null;
}
