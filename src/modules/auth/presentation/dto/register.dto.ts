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
  HOUR_CYCLES,
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
  // formato regional, con las mismas reglas que el alta de sede. Sin ellos
  // (la forma legada de una web antigua) o con un subconjunto, 400 con el
  // mensaje del primero que falta. Presencia y mensajes exactos los comprueba
  // el caso de uso (la moneda se valida contra `currencies`).
  @ApiPropertyOptional({
    enum: ClinicCountry,
    enumName: 'ClinicCountry',
    description:
      'País de la primera sede. Obligatorio junto con los otros tres campos location*.',
  })
  @IsOptional()
  @IsEnum(ClinicCountry, { message: COUNTRY_MISSING })
  locationCountry?: ClinicCountry;

  @ApiPropertyOptional({
    type: String,
    example: 'EUR',
    description: 'Moneda ISO 4217 de la primera sede (GET /public/currencies).',
  })
  @IsOptional()
  @IsString({ message: REGIONAL_MESSAGES.currencyMissing })
  locationCurrency?: string;

  @ApiPropertyOptional({
    type: String,
    example: 'Europe/Madrid',
    description: 'Zona horaria IANA de la primera sede.',
  })
  @IsOptional()
  @IsString({ message: REGIONAL_MESSAGES.timeZoneMissing })
  locationTimeZone?: string;

  @ApiPropertyOptional({
    type: String,
    example: 'es-ES',
    description: 'Formato regional BCP 47 de la primera sede.',
  })
  @IsOptional()
  @IsString({ message: REGIONAL_MESSAGES.localeMissing })
  locationLocale?: string;

  // G1-B (DX-350, spec §4.3): reloj de la primera sede, validado por el caso
  // de uso con los mensajes del alta de sede. Fase 1: opcional, porque la web
  // de G1 envía los cuatro sin él; solo, sin los otros cuatro, es 400.
  @ApiPropertyOptional({
    type: String,
    enum: [...HOUR_CYCLES],
    example: 'h23',
    description:
      'Reloj de la primera sede: h12 (12 h) o h23 (24 h). Fase 1: sin él, con los otros cuatro location*, la sede recibe el reloj de la función de backfill; fase 2: obligatorio.',
  })
  @IsOptional()
  @IsString({ message: REGIONAL_MESSAGES.hourCycleMissing })
  locationHourCycle?: string;
}
