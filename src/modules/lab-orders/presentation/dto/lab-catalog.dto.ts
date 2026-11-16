import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  LAB_CONTACT_MAX,
  LAB_EMAIL_MAX,
  LAB_NAME_MAX,
  LAB_NOTES_MAX,
  LAB_PHONE_MAX,
  LEAD_TIME_MAX,
  LEAD_TIME_MIN,
} from '../../domain/lab-order-rules';

// Laboratorio dental (DX-017): catálogo de la clínica. Sin tenant ni fechas:
// los pone el servidor. Nunca se borra: se desactiva con `active: false`.

const PRICE_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;

export class DentalLabServiceDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) labId!: string;
  @ApiProperty({ example: 'Corona zirconio' }) name!: string;
  @ApiProperty({ minimum: LEAD_TIME_MIN, maximum: LEAD_TIME_MAX, example: 5 })
  leadTimeBusinessDays!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '180.00',
    description:
      'Precio de referencia (decimal en texto). Solo ADMIN; null para el resto.',
  })
  referencePrice!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'USD',
    description: 'ISO 4217. Solo ADMIN; null para el resto.',
  })
  referenceCurrency!: string | null;
  @ApiProperty() active!: boolean;
}

export class DentalLabDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Laboratorio Dental Caracas' }) name!: string;
  @ApiProperty({ type: String, nullable: true, example: 'Carmen Rondón' })
  contactName!: string | null;
  @ApiProperty({ type: String, nullable: true, example: '+58 212 555 0142' })
  phone!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'pedidos@labcaracas.com.ve',
  })
  email!: string | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty() active!: boolean;
  @ApiProperty({ type: [DentalLabServiceDto] })
  services!: DentalLabServiceDto[];
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: Date;
}

export class ListDentalLabsQueryDto {
  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description:
      'true = también los desactivados (pantalla de gestión). Por defecto, solo los activos.',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean({ message: 'includeInactive debe ser true o false' })
  includeInactive?: boolean;
}

export class CreateDentalLabDto {
  @ApiProperty({
    maxLength: LAB_NAME_MAX,
    example: 'Laboratorio Dental Caracas',
  })
  @IsString({ message: 'El nombre del laboratorio debe ser un texto' })
  @IsNotEmpty({ message: 'El nombre del laboratorio es obligatorio' })
  @MaxLength(LAB_NAME_MAX, {
    message: `El nombre del laboratorio admite hasta ${LAB_NAME_MAX} caracteres`,
  })
  name!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: LAB_CONTACT_MAX,
  })
  @IsOptional()
  @IsString({ message: 'La persona de contacto debe ser un texto' })
  @MaxLength(LAB_CONTACT_MAX, {
    message: `La persona de contacto admite hasta ${LAB_CONTACT_MAX} caracteres`,
  })
  contactName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: LAB_PHONE_MAX,
  })
  @IsOptional()
  @IsString({ message: 'El teléfono debe ser un texto' })
  @MaxLength(LAB_PHONE_MAX, {
    message: `El teléfono admite hasta ${LAB_PHONE_MAX} caracteres`,
  })
  phone?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: LAB_EMAIL_MAX,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== '')
  @IsString({ message: 'El email debe ser un texto' })
  @MaxLength(LAB_EMAIL_MAX, {
    message: `El email admite hasta ${LAB_EMAIL_MAX} caracteres`,
  })
  @IsEmail({}, { message: 'El email del laboratorio no es válido' })
  email?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: LAB_NOTES_MAX,
  })
  @IsOptional()
  @IsString({ message: 'Las notas deben ser un texto' })
  @MaxLength(LAB_NOTES_MAX, {
    message: `Las notas admiten hasta ${LAB_NOTES_MAX} caracteres`,
  })
  notes?: string | null;
}

export class UpdateDentalLabDto {
  @ApiPropertyOptional({ maxLength: LAB_NAME_MAX })
  @IsOptional()
  @IsString({ message: 'El nombre del laboratorio debe ser un texto' })
  @IsNotEmpty({ message: 'El nombre del laboratorio no puede quedar vacío' })
  @MaxLength(LAB_NAME_MAX, {
    message: `El nombre del laboratorio admite hasta ${LAB_NAME_MAX} caracteres`,
  })
  name?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: LAB_CONTACT_MAX,
  })
  @IsOptional()
  @IsString({ message: 'La persona de contacto debe ser un texto' })
  @MaxLength(LAB_CONTACT_MAX, {
    message: `La persona de contacto admite hasta ${LAB_CONTACT_MAX} caracteres`,
  })
  contactName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: LAB_PHONE_MAX,
  })
  @IsOptional()
  @IsString({ message: 'El teléfono debe ser un texto' })
  @MaxLength(LAB_PHONE_MAX, {
    message: `El teléfono admite hasta ${LAB_PHONE_MAX} caracteres`,
  })
  phone?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: LAB_EMAIL_MAX,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== '')
  @IsString({ message: 'El email debe ser un texto' })
  @MaxLength(LAB_EMAIL_MAX, {
    message: `El email admite hasta ${LAB_EMAIL_MAX} caracteres`,
  })
  @IsEmail({}, { message: 'El email del laboratorio no es válido' })
  email?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: LAB_NOTES_MAX,
  })
  @IsOptional()
  @IsString({ message: 'Las notas deben ser un texto' })
  @MaxLength(LAB_NOTES_MAX, {
    message: `Las notas admiten hasta ${LAB_NOTES_MAX} caracteres`,
  })
  notes?: string | null;

  @ApiPropertyOptional({ description: 'false = desactivar (nunca se borra)' })
  @IsOptional()
  @IsBoolean({ message: 'Indica si el laboratorio está activo (sí o no)' })
  active?: boolean;
}

export class CreateDentalLabServiceDto {
  @ApiProperty({ maxLength: LAB_NAME_MAX, example: 'Corona zirconio' })
  @IsString({ message: 'El nombre del servicio debe ser un texto' })
  @IsNotEmpty({ message: 'El nombre del servicio es obligatorio' })
  @MaxLength(LAB_NAME_MAX, {
    message: `El nombre del servicio admite hasta ${LAB_NAME_MAX} caracteres`,
  })
  name!: string;

  @ApiProperty({ minimum: LEAD_TIME_MIN, maximum: LEAD_TIME_MAX, example: 5 })
  @Type(() => Number)
  @IsInt({ message: 'El plazo debe ser un número entero de días hábiles' })
  @Min(LEAD_TIME_MIN, {
    message: `El plazo va de ${LEAD_TIME_MIN} a ${LEAD_TIME_MAX} días hábiles`,
  })
  @Max(LEAD_TIME_MAX, {
    message: `El plazo va de ${LEAD_TIME_MIN} a ${LEAD_TIME_MAX} días hábiles`,
  })
  leadTimeBusinessDays!: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '180.00',
    description:
      'Decimal ≥ 0 con hasta 2 decimales, en texto. Va junto a la moneda.',
  })
  @IsOptional()
  @IsString({
    message:
      'El precio de referencia debe ser un número en texto, p. ej. «180.00»',
  })
  @Matches(PRICE_PATTERN, {
    message:
      'El precio de referencia debe ser un número ≥ 0 con hasta 2 decimales',
  })
  referencePrice?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'USD' })
  @IsOptional()
  @IsString({ message: 'La moneda debe ser un código ISO 4217 de 3 letras' })
  @Matches(CURRENCY_PATTERN, {
    message: 'La moneda debe ser un código ISO 4217 de 3 letras',
  })
  referenceCurrency?: string | null;
}

export class UpdateDentalLabServiceDto {
  @ApiPropertyOptional({ maxLength: LAB_NAME_MAX })
  @IsOptional()
  @IsString({ message: 'El nombre del servicio debe ser un texto' })
  @IsNotEmpty({ message: 'El nombre del servicio no puede quedar vacío' })
  @MaxLength(LAB_NAME_MAX, {
    message: `El nombre del servicio admite hasta ${LAB_NAME_MAX} caracteres`,
  })
  name?: string;

  @ApiPropertyOptional({ minimum: LEAD_TIME_MIN, maximum: LEAD_TIME_MAX })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'El plazo debe ser un número entero de días hábiles' })
  @Min(LEAD_TIME_MIN, {
    message: `El plazo va de ${LEAD_TIME_MIN} a ${LEAD_TIME_MAX} días hábiles`,
  })
  @Max(LEAD_TIME_MAX, {
    message: `El plazo va de ${LEAD_TIME_MIN} a ${LEAD_TIME_MAX} días hábiles`,
  })
  leadTimeBusinessDays?: number;

  @ApiPropertyOptional({ type: String, nullable: true, example: '180.00' })
  @IsOptional()
  @IsString({
    message:
      'El precio de referencia debe ser un número en texto, p. ej. «180.00»',
  })
  @Matches(PRICE_PATTERN, {
    message:
      'El precio de referencia debe ser un número ≥ 0 con hasta 2 decimales',
  })
  referencePrice?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'USD' })
  @IsOptional()
  @IsString({ message: 'La moneda debe ser un código ISO 4217 de 3 letras' })
  @Matches(CURRENCY_PATTERN, {
    message: 'La moneda debe ser un código ISO 4217 de 3 letras',
  })
  referenceCurrency?: string | null;

  @ApiPropertyOptional({ description: 'false = desactivar (nunca se borra)' })
  @IsOptional()
  @IsBoolean({ message: 'Indica si el servicio está activo (sí o no)' })
  active?: boolean;
}
