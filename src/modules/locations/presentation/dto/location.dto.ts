import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClinicCountry } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

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
