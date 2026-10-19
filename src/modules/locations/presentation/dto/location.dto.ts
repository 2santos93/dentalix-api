import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClinicCountry } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export const LOCATION_PHONE_MAX = 40;
const PHONE_MESSAGE = `El teléfono admite hasta ${LOCATION_PHONE_MAX} caracteres.`;
const PHONE_DOC =
  'DX-222: teléfono de la sede que ven los pacientes en las indicaciones postoperatorias ({{telefono_sede}}). Hasta 40 caracteres.';

const COUNTRY_DOC = {
  enum: ClinicCountry,
  enumName: 'ClinicCountry',
  description:
    'País de la sede: decide los campos legales obligatorios de la receta (CO o ES). Por defecto CO.',
};

export class CreateLocationDto {
  @ApiProperty({ example: 'Sede Norte' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiPropertyOptional({ example: 'Cra 15 #90-20' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional(COUNTRY_DOC)
  @IsOptional()
  @IsEnum(ClinicCountry)
  country?: ClinicCountry;

  @ApiPropertyOptional({
    example: '+57 601 555 0101',
    maxLength: LOCATION_PHONE_MAX,
    description: PHONE_DOC,
  })
  @IsOptional()
  @IsString({ message: 'El teléfono debe ser un texto.' })
  @MaxLength(LOCATION_PHONE_MAX, { message: PHONE_MESSAGE })
  phone?: string;
}

export class UpdateLocationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional(COUNTRY_DOC)
  @IsOptional()
  @IsEnum(ClinicCountry)
  country?: ClinicCountry;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '110010123401',
    description:
      'DX-212: código de habilitación REPS de la sede (Colombia), 12 dígitos (400 con el formato esperado si no). Vacío o null lo quita. Solo ADMIN; queda auditado.',
  })
  @IsOptional()
  @IsString()
  repsHabilitationCode?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '+57 601 555 0101',
    maxLength: LOCATION_PHONE_MAX,
    description: `${PHONE_DOC} Vacío o null lo quita.`,
  })
  @IsOptional()
  @IsString({ message: 'El teléfono debe ser un texto.' })
  @MaxLength(LOCATION_PHONE_MAX, { message: PHONE_MESSAGE })
  phone?: string | null;

  @ApiPropertyOptional({
    description:
      'Desactivar una sede la oculta para operar; no se puede desactivar la última activa.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class LocationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) address!: string | null;
  @ApiProperty({ enum: ClinicCountry, enumName: 'ClinicCountry' })
  country!: ClinicCountry;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'DX-212: código de habilitación REPS (12 dígitos) o null.',
  })
  repsHabilitationCode!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'DX-222: teléfono de la sede o null.',
  })
  phone!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({
    example: 'America/Bogota',
    description:
      'Zona horaria IANA de la sede (la de su horario; sin horario, la de su ' +
      'país). Define sus días civiles: «hoy» en la caja y el dashboard (DX-097).',
  })
  timeZone!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
}
