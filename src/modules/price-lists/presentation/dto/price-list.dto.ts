import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  IsMoney,
  MONEY_MAX,
} from '../../../../shared/validation/bounded-decimal';
import {
  PRICE_LIST_ITEMS_MAX,
  PRICE_LIST_NAME_MAX,
  PRICE_LIST_NAME_MESSAGE,
  PRICE_LIST_NAME_MIN,
} from '../../domain/price-list-rules';

const CURRENCY_MESSAGE = 'La moneda debe ser un código de 3 letras.';
const LOCATION_MESSAGE = 'La sede debe ser un identificador válido.';

/**
 * Para columnas NOT NULL en el PATCH: `@IsOptional()` saltaría los validadores
 * con `null` y llegaría a Prisma como 500. Ausente = no se toca; `null` = 400.
 */
function NotNullable(): PropertyDecorator {
  return ValidateIf((_object: unknown, value: unknown) => value !== undefined);
}

/** Respuesta de los endpoints de listas de precios (DX-105). */
export class PriceListDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Convenio Sura EPS' })
  name!: string;

  @ApiProperty({ example: 'COP', description: 'Código ISO 4217' })
  currency!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null = toda la clínica. A lo sumo una lista activa por sede.',
  })
  locationId!: string | null;

  @ApiProperty()
  active!: boolean;

  @ApiProperty({ description: 'Procedimientos con precio en la lista.' })
  itemCount!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

// Sin `tenantId`: sale del contexto del request.
export class CreatePriceListDto {
  @ApiProperty({
    minLength: PRICE_LIST_NAME_MIN,
    maxLength: PRICE_LIST_NAME_MAX,
  })
  @IsString({ message: PRICE_LIST_NAME_MESSAGE })
  @Length(PRICE_LIST_NAME_MIN, PRICE_LIST_NAME_MAX, {
    message: PRICE_LIST_NAME_MESSAGE,
  })
  name!: string;

  @ApiProperty({
    example: 'COP',
    description: 'Código ISO 4217 de `currencies`.',
  })
  @IsString({ message: CURRENCY_MESSAGE })
  @Length(3, 3, { message: CURRENCY_MESSAGE })
  currency!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Sede de la lista; ausente o null = toda la clínica.',
  })
  @IsOptional()
  @IsUUID('all', { message: LOCATION_MESSAGE })
  locationId?: string | null;
}

export class UpdatePriceListDto {
  @ApiPropertyOptional({
    minLength: PRICE_LIST_NAME_MIN,
    maxLength: PRICE_LIST_NAME_MAX,
  })
  @NotNullable()
  @IsString({ message: PRICE_LIST_NAME_MESSAGE })
  @Length(PRICE_LIST_NAME_MIN, PRICE_LIST_NAME_MAX, {
    message: PRICE_LIST_NAME_MESSAGE,
  })
  name?: string;

  @ApiPropertyOptional({
    example: 'COP',
    description: 'Con precios cargados, otra moneda da 409.',
  })
  @NotNullable()
  @IsString({ message: CURRENCY_MESSAGE })
  @Length(3, 3, { message: CURRENCY_MESSAGE })
  currency?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'null = toda la clínica.',
  })
  @IsOptional()
  @IsUUID('all', { message: LOCATION_MESSAGE })
  locationId?: string | null;

  @ApiPropertyOptional({ description: 'false = deja de resolver precios.' })
  @NotNullable()
  @IsBoolean({ message: 'El estado activo debe ser verdadero o falso.' })
  active?: boolean;
}

export class ListPriceListsQueryDto {
  @ApiPropertyOptional({
    description:
      'true = también las desactivadas (pantalla de gestión). Por defecto, solo las activas.',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInactive?: boolean;
}

/** Fila del directorio de una lista: un procedimiento y su precio o null. */
export class PriceListItemRowDto {
  @ApiProperty({ format: 'uuid' })
  catalogItemId!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  labelEs!: string;

  @ApiProperty({ type: String, nullable: true })
  category!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  defaultPrice!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Precio en esta lista; null = sin precio.',
  })
  price!: number | null;
}

export class PriceListItemsPageDto {
  @ApiProperty({ type: [PriceListItemRowDto] })
  items!: PriceListItemRowDto[];

  @ApiProperty({ description: 'Total que casa con la búsqueda.' })
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}

export class ListPriceListItemsQueryDto {
  @ApiPropertyOptional({
    description: 'Búsqueda libre (código, etiqueta es/en/pt o categoría)',
  })
  @IsOptional()
  @IsString()
  query?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}

export class PriceListItemInputDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all', { message: 'La prestación debe ser un identificador válido.' })
  catalogItemId!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    maximum: MONEY_MAX,
    description: 'Hasta 2 decimales. null quita el precio de la lista.',
  })
  // `null` es un valor válido (quita el precio); lo AUSENTE no: entra al
  // validador y da 400.
  @ValidateIf((_object: unknown, value: unknown) => value !== null)
  @IsNumber({}, { message: 'El precio debe ser un número o null.' })
  @Min(0, { message: 'El precio no puede ser negativo.' })
  @IsMoney({
    message: 'El precio admite hasta 2 decimales y un máximo razonable.',
  })
  price!: number | null;
}

export class ReplacePriceListItemsDto {
  @ApiProperty({
    type: [PriceListItemInputDto],
    maxItems: PRICE_LIST_ITEMS_MAX,
  })
  @IsArray()
  @ArrayMaxSize(PRICE_LIST_ITEMS_MAX, {
    message: `Máximo ${PRICE_LIST_ITEMS_MAX} precios por envío.`,
  })
  @ValidateNested({ each: true })
  @Type(() => PriceListItemInputDto)
  items!: PriceListItemInputDto[];
}

export class ReplacePriceListItemsResultDto {
  @ApiProperty({ description: 'Precios creados o actualizados.' })
  upserted!: number;

  @ApiProperty({ description: 'Precios quitados (filas con price null).' })
  removed!: number;
}
