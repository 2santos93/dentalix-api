import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  APPOINTMENT_TYPE_COLOR,
  APPOINTMENT_TYPE_MAX_MINUTES,
  APPOINTMENT_TYPE_MIN_MINUTES,
  APPOINTMENT_TYPE_NAME_MAX,
  PRE_VISIT_INSTRUCTIONS_MAX_LANGUAGES,
  PRE_VISIT_INSTRUCTIONS_NOT_A_LIST_MESSAGE,
  PRE_VISIT_INSTRUCTIONS_TEXT_MAX,
  PRE_VISIT_INSTRUCTIONS_TOO_MANY_MESSAGE,
} from '../../domain/appointment-type-rules';
import {
  INPUT_REASON_MAX,
  TextMaxLength,
} from '../../../../shared/validation/input-limits';

/** Etiqueta BCP 47: el tope de RFC 5646 que también usa `canonicalLanguageTag`. */
const LANGUAGE_TAG_MAX = 35;

/** DX-564: las indicaciones previas de un tipo de cita en un idioma. */
export class PreVisitInstructionDto {
  @ApiProperty({
    maxLength: LANGUAGE_TAG_MAX,
    example: 'es',
    description:
      'Etiqueta BCP 47 de uno de los idiomas de los pacientes de la clínica (`tenants.patientLanguages`).',
  })
  @IsString({ message: 'El idioma de las indicaciones debe ser un texto.' })
  @TextMaxLength(LANGUAGE_TAG_MAX)
  language!: string;

  @ApiProperty({
    maxLength: PRE_VISIT_INSTRUCTIONS_TEXT_MAX,
    example: 'Ven en ayunas de 6 horas y trae tus radiografías.',
    description: `Texto plano de hasta ${PRE_VISIT_INSTRUCTIONS_TEXT_MAX} caracteres tras recortar, con saltos de línea; sin enlaces ni HTML. Vacío = sin indicaciones en ese idioma.`,
  })
  @IsString({ message: 'Las indicaciones deben ser un texto.' })
  // Red contra cuerpos enormes; el tope de 600 lo da el dominio con su mensaje.
  @TextMaxLength(INPUT_REASON_MAX)
  text!: string;
}

const COLOR_MESSAGE =
  'El color debe tener el formato #RRGGBB (por ejemplo, #7C3AED)';
const DURATION_MESSAGE = `La duración debe ser un múltiplo de 5 entre ${APPOINTMENT_TYPE_MIN_MINUTES} y ${APPOINTMENT_TYPE_MAX_MINUTES} minutos`;

/** Respuesta de los endpoints de tipos de cita (DX-121). */
export class AppointmentTypeDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ example: 'Endodoncia' })
  name!: string;

  @ApiProperty({ minimum: 5, maximum: 480, multipleOf: 5, example: 90 })
  durationMinutes!: number;

  @ApiProperty({ pattern: '^#[0-9A-F]{6}$', example: '#7C3AED' })
  color!: string;

  @ApiProperty()
  active!: boolean;

  @ApiProperty({
    description:
      'DX-446: tipo de urgencia (p. ej. «Consulta de urgencia»): se ofrece primero al reservar huecos.',
  })
  isUrgent!: boolean;

  @ApiProperty({
    type: [PreVisitInstructionDto],
    description:
      'DX-564: indicaciones previas a la cita, una por idioma con texto (español primero y luego por orden alfabético de etiqueta). Vacía = sin indicaciones.',
  })
  preVisitInstructions!: PreVisitInstructionDto[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

/** Lo que una cita embebe de su tipo. */
export class AppointmentTypeSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  durationMinutes!: number;

  @ApiProperty({ pattern: '^#[0-9A-F]{6}$' })
  color!: string;

  @ApiProperty({
    description:
      'DX-564: el tipo tiene indicaciones previas en algún idioma. El texto está en `GET /appointment-types` (`preVisitInstructions`).',
  })
  hasPreVisitInstructions!: boolean;
}

// Sin `tenantId`: sale del contexto del request.
export class CreateAppointmentTypeDto {
  @ApiProperty({ minLength: 1, maxLength: APPOINTMENT_TYPE_NAME_MAX })
  @IsString()
  @MaxLength(APPOINTMENT_TYPE_NAME_MAX)
  name!: string;

  @ApiProperty({
    minimum: APPOINTMENT_TYPE_MIN_MINUTES,
    maximum: APPOINTMENT_TYPE_MAX_MINUTES,
    multipleOf: 5,
  })
  @IsInt({ message: DURATION_MESSAGE })
  @Min(APPOINTMENT_TYPE_MIN_MINUTES, { message: DURATION_MESSAGE })
  @Max(APPOINTMENT_TYPE_MAX_MINUTES, { message: DURATION_MESSAGE })
  durationMinutes!: number;

  @ApiProperty({ pattern: '^#[0-9A-Fa-f]{6}$', example: '#7C3AED' })
  @IsString({ message: COLOR_MESSAGE })
  @Matches(APPOINTMENT_TYPE_COLOR, { message: COLOR_MESSAGE })
  color!: string;

  @ApiPropertyOptional({ description: 'Por defecto, true' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({
    description: 'DX-446: tipo de urgencia. Por defecto, false',
  })
  @IsOptional()
  @IsBoolean()
  isUrgent?: boolean;

  @ApiPropertyOptional({
    type: [PreVisitInstructionDto],
    maxItems: PRE_VISIT_INSTRUCTIONS_MAX_LANGUAGES,
    description:
      'DX-564: la lista ENTERA de indicaciones previas (un idioma que no viene se quita; vacía = sin indicaciones). Sin el campo, no se tocan. Idiomas de la lista de la clínica y sin repetir; una entrada con texto vacío se descarta.',
  })
  // `null` no es «sin el campo»: 400 (solo `undefined` lo deja sin tocar).
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ message: PRE_VISIT_INSTRUCTIONS_NOT_A_LIST_MESSAGE })
  @ArrayMaxSize(PRE_VISIT_INSTRUCTIONS_MAX_LANGUAGES, {
    message: PRE_VISIT_INSTRUCTIONS_TOO_MANY_MESSAGE,
  })
  @ValidateNested({ each: true })
  @Type(() => PreVisitInstructionDto)
  preVisitInstructions?: PreVisitInstructionDto[] | null;
}

export class UpdateAppointmentTypeDto extends PartialType(
  CreateAppointmentTypeDto,
) {}

export class ListAppointmentTypesQueryDto {
  @ApiPropertyOptional({
    description:
      'true = también los desactivados (pantalla de gestión). Por defecto, solo los activos.',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}
