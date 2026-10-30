import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { AgreementKind } from '@prisma/client';
import { PAYER_TYPES, type PayerType } from '../../../payers/domain/payer-type';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
  ValidateIf,
} from 'class-validator';
import { IsBoundedDecimal } from '../../../../shared/validation/bounded-decimal';
import {
  AGREEMENT_DATE_FORMAT_MESSAGE,
  AGREEMENT_NAME_MAX,
  AGREEMENT_NAME_MESSAGE,
  AGREEMENT_NAME_MIN,
  AGREEMENT_PERCENT_RANGE_MESSAGE,
  CATEGORY_KEY_MAX,
  PERCENT_BY_CATEGORY_MAX_KEYS,
  PERCENT_MAX,
  PERCENT_MIN,
} from '../../domain/agreement-rules';
import { IsPercentByCategory } from './percent-by-category.validator';

const KIND_MESSAGE = `El tipo de convenio debe ser uno de: ${Object.values(AgreementKind).join(', ')}.`;
const PAYER_MESSAGE = 'El pagador debe ser un identificador válido.';
const PRICE_LIST_MESSAGE =
  'La lista de precios debe ser un identificador válido.';
const LOCATION_MESSAGE = 'La sede debe ser un identificador válido.';
const ACTIVE_MESSAGE = 'El estado activo debe ser verdadero o falso.';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Para columnas NOT NULL en el PATCH: `@IsOptional()` saltaría los validadores
 * con `null` y llegaría a Prisma como 500. Ausente = no se toca; `null` = 400.
 */
function NotNullable(): PropertyDecorator {
  return ValidateIf((_object: unknown, value: unknown) => value !== undefined);
}

/** Respuesta de los endpoints de convenios (DX-105). */
export class AgreementPayerDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sanitas' })
  name!: string;

  @ApiProperty({
    enum: PAYER_TYPES,
    enumName: 'PayerType',
    description:
      'SEC-047: con un pagador externo, asignar el convenio exige una cobertura viva del paciente con él; OTHER (cortesía, empleados…) solo lo asigna ADMIN.',
  })
  type!: PayerType;
}

export class AgreementPriceListDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Lista Sanitas 2026' })
  name!: string;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;
}

export class AgreementDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Convenio Sanitas' })
  name!: string;

  @ApiProperty({ type: AgreementPayerDto })
  payer!: AgreementPayerDto;

  @ApiProperty({ enum: AgreementKind, enumName: 'AgreementKind' })
  kind!: AgreementKind;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Solo PERCENT_DISCOUNT: 0–100.',
  })
  percent!: number | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    nullable: true,
    description:
      'Solo PERCENT_DISCOUNT: porcentaje por categoría del catálogo; gana sobre `percent`.',
  })
  percentByCategory!: Record<string, number> | null;

  @ApiProperty({ type: AgreementPriceListDto, nullable: true })
  priceList!: AgreementPriceListDto | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null = toda la clínica.',
  })
  locationId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-01-01' })
  validFrom!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-12-31' })
  validTo!: string | null;

  @ApiProperty()
  active!: boolean;

  @ApiProperty({ description: 'Pacientes con este convenio asignado hoy.' })
  assignedCount!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

// Sin `tenantId`: sale del contexto del request. Que cada `kind` lleve sus
// campos (y solo ellos) lo comprueba el caso de uso, con el mensaje de dominio.
export class CreateAgreementDto {
  @ApiProperty({ minLength: AGREEMENT_NAME_MIN, maxLength: AGREEMENT_NAME_MAX })
  @IsString({ message: AGREEMENT_NAME_MESSAGE })
  @Length(AGREEMENT_NAME_MIN, AGREEMENT_NAME_MAX, {
    message: AGREEMENT_NAME_MESSAGE,
  })
  name!: string;

  @ApiProperty({ format: 'uuid', description: 'Pagador vivo y activo.' })
  @IsUUID('all', { message: PAYER_MESSAGE })
  payerId!: string;

  @ApiProperty({ enum: AgreementKind, enumName: 'AgreementKind' })
  @IsEnum(AgreementKind, { message: KIND_MESSAGE })
  kind!: AgreementKind;

  @ApiPropertyOptional({
    minimum: PERCENT_MIN,
    maximum: PERCENT_MAX,
    description: 'Obligatorio con PERCENT_DISCOUNT; no va con PRICE_LIST.',
  })
  @IsOptional()
  @IsNumber({}, { message: AGREEMENT_PERCENT_RANGE_MESSAGE })
  @Min(PERCENT_MIN, { message: AGREEMENT_PERCENT_RANGE_MESSAGE })
  @IsBoundedDecimal(
    { maxDecimals: 2, maxAbs: PERCENT_MAX },
    { message: AGREEMENT_PERCENT_RANGE_MESSAGE },
  )
  percent?: number | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'number' },
    description: `{ "<categoría del catálogo>": <0–100> }, hasta ${PERCENT_BY_CATEGORY_MAX_KEYS} categorías de ${CATEGORY_KEY_MAX} caracteres. Solo PERCENT_DISCOUNT.`,
  })
  @IsOptional()
  @IsPercentByCategory()
  percentByCategory?: Record<string, number> | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'Obligatorio con PRICE_LIST; no va con PERCENT_DISCOUNT.',
  })
  @IsOptional()
  @IsUUID('all', { message: PRICE_LIST_MESSAGE })
  priceListId?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'Sede del convenio; ausente o null = toda la clínica.',
  })
  @IsOptional()
  @IsUUID('all', { message: LOCATION_MESSAGE })
  locationId?: string | null;

  @ApiPropertyOptional({ type: String, example: '2026-01-01' })
  @IsOptional()
  @Matches(DATE_RE, { message: AGREEMENT_DATE_FORMAT_MESSAGE })
  validFrom?: string | null;

  @ApiPropertyOptional({ type: String, example: '2026-12-31' })
  @IsOptional()
  @Matches(DATE_RE, { message: AGREEMENT_DATE_FORMAT_MESSAGE })
  validTo?: string | null;

  @ApiPropertyOptional({ description: 'Por defecto true.' })
  @NotNullable()
  @IsBoolean({ message: ACTIVE_MESSAGE })
  active?: boolean;
}

export class UpdateAgreementDto {
  @ApiPropertyOptional({
    minLength: AGREEMENT_NAME_MIN,
    maxLength: AGREEMENT_NAME_MAX,
  })
  @NotNullable()
  @IsString({ message: AGREEMENT_NAME_MESSAGE })
  @Length(AGREEMENT_NAME_MIN, AGREEMENT_NAME_MAX, {
    message: AGREEMENT_NAME_MESSAGE,
  })
  name?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @NotNullable()
  @IsUUID('all', { message: PAYER_MESSAGE })
  payerId?: string;

  @ApiPropertyOptional({
    enum: AgreementKind,
    enumName: 'AgreementKind',
    description:
      'Al cambiarlo se vacían los campos del otro tipo y se piden los del nuevo.',
  })
  @NotNullable()
  @IsEnum(AgreementKind, { message: KIND_MESSAGE })
  kind?: AgreementKind;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsNumber({}, { message: AGREEMENT_PERCENT_RANGE_MESSAGE })
  @Min(PERCENT_MIN, { message: AGREEMENT_PERCENT_RANGE_MESSAGE })
  @IsBoundedDecimal(
    { maxDecimals: 2, maxAbs: PERCENT_MAX },
    { message: AGREEMENT_PERCENT_RANGE_MESSAGE },
  )
  percent?: number | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'number' },
    nullable: true,
    description: 'null vacía los porcentajes por categoría.',
  })
  @IsOptional()
  @IsPercentByCategory()
  percentByCategory?: Record<string, number> | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('all', { message: PRICE_LIST_MESSAGE })
  priceListId?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null = toda la clínica.',
  })
  @IsOptional()
  @IsUUID('all', { message: LOCATION_MESSAGE })
  locationId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-01-01' })
  @IsOptional()
  @Matches(DATE_RE, { message: AGREEMENT_DATE_FORMAT_MESSAGE })
  validFrom?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-12-31' })
  @IsOptional()
  @Matches(DATE_RE, { message: AGREEMENT_DATE_FORMAT_MESSAGE })
  validTo?: string | null;

  @ApiPropertyOptional({
    description: 'false = sale de la resolución de precios.',
  })
  @NotNullable()
  @IsBoolean({ message: ACTIVE_MESSAGE })
  active?: boolean;
}

export class ListAgreementsQueryDto {
  @ApiPropertyOptional({
    description:
      'true = también los desactivados (pantalla de gestión). Por defecto, solo los activos.',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}
