import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClinicCountry } from '@prisma/client';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  COUNTRY_MISSING,
  REGIONAL_MESSAGES,
} from '../../../locations/domain/regional-settings';

/**
 * DX-144 (SEC-034): tope de lo que escribe quien pide el alta, como en las
 * invitaciones (`CreateInvitationDto`). El alta es pública y su email sale a
 * cualquier dirección: nada de párrafos libres.
 */
export const REGISTER_TEXT_MAX_LENGTH = 120;

export class RegisterDto {
  @ApiProperty({ minLength: 2, maxLength: REGISTER_TEXT_MAX_LENGTH })
  @IsString()
  @MinLength(2, {
    message: 'El nombre de la clínica debe tener al menos 2 caracteres',
  })
  @MaxLength(REGISTER_TEXT_MAX_LENGTH, {
    message: `El nombre de la clínica admite como mucho ${REGISTER_TEXT_MAX_LENGTH} caracteres`,
  })
  clinicName!: string;

  @ApiProperty({ pattern: '^[a-z0-9-]+$', example: 'sonrisa' })
  @Matches(/^[a-z0-9-]+$/, {
    message: 'subdomain must be lowercase alphanumeric or hyphen',
  })
  subdomain!: string;

  @ApiProperty({ format: 'email' })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 8, format: 'password' })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiProperty({ minLength: 2, maxLength: REGISTER_TEXT_MAX_LENGTH })
  @IsString()
  @MinLength(2, { message: 'Tu nombre debe tener al menos 2 caracteres' })
  @MaxLength(REGISTER_TEXT_MAX_LENGTH, {
    message: `Tu nombre admite como mucho ${REGISTER_TEXT_MAX_LENGTH} caracteres`,
  })
  fullName!: string;

  // G1 (spec §3.5): la primera sede se registra con país, moneda, zona y
  // formato regional, con las mismas reglas que el alta de sede. Fase 1: se
  // acepta también la forma LEGADA (los cuatro ausentes, una web antigua); un
  // subconjunto es 400 con el mensaje del primero que falta. Presencia y
  // mensajes exactos los comprueba el caso de uso (la moneda se valida contra
  // `currencies`). Fase 2 los hace obligatorios.
  @ApiPropertyOptional({
    enum: ClinicCountry,
    enumName: 'ClinicCountry',
    description:
      'País de la primera sede. Obligatorio junto con los otros tres campos location*; sin los cuatro es la forma legada (fase 1).',
  })
  @IsOptional()
  @IsEnum(ClinicCountry, { message: COUNTRY_MISSING })
  locationCountry?: ClinicCountry;

  @ApiPropertyOptional({
    example: 'COP',
    description: 'Moneda ISO 4217 de la primera sede (GET /public/currencies).',
  })
  @IsOptional()
  @IsString({ message: REGIONAL_MESSAGES.currencyMissing })
  locationCurrency?: string;

  @ApiPropertyOptional({
    example: 'America/Bogota',
    description: 'Zona horaria IANA de la primera sede.',
  })
  @IsOptional()
  @IsString({ message: REGIONAL_MESSAGES.timeZoneMissing })
  locationTimeZone?: string;

  @ApiPropertyOptional({
    example: 'es-CO',
    description: 'Formato regional BCP 47 de la primera sede.',
  })
  @IsOptional()
  @IsString({ message: REGIONAL_MESSAGES.localeMissing })
  locationLocale?: string;
}
