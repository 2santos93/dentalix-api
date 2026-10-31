import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  APPOINTMENT_TYPE_COLOR,
  APPOINTMENT_TYPE_MAX_MINUTES,
  APPOINTMENT_TYPE_MIN_MINUTES,
  APPOINTMENT_TYPE_NAME_MAX,
} from '../../domain/appointment-type-rules';

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
