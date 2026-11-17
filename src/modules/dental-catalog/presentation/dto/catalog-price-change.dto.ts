import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { CatalogKind } from '@prisma/client';
import {
  INPUT_NAME_MAX,
  TextMaxLength,
} from '../../../../shared/validation/input-limits';
import {
  IsBoundedDecimal,
  IsPositiveMoney,
  MONEY_MAX,
} from '../../../../shared/validation/bounded-decimal';
import {
  PRICE_CHANGE_ROUNDING_UNITS,
  type PriceChangeMode,
  type PriceChangeSkipReason,
} from '../../domain/price-change';

const MODES: PriceChangeMode[] = ['PERCENT', 'AMOUNT'];
const SKIP_REASONS: PriceChangeSkipReason[] = [
  'NO_PRICE',
  'UNCHANGED',
  'OUT_OF_RANGE',
];

const trimmedOrUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;

/** Filtros y cambio de «Actualizar precios» (DX-205). */
export class CatalogPriceChangeDto {
  @ApiPropertyOptional({
    description:
      'Solo los ítems de esta categoría (exacta, sin distinguir mayúsculas). Sin ella, todas.',
    maxLength: INPUT_NAME_MAX,
  })
  @IsOptional()
  @Transform(trimmedOrUndefined)
  @IsString({ message: 'La categoría debe ser un texto.' })
  @TextMaxLength(INPUT_NAME_MAX)
  category?: string;

  @ApiPropertyOptional({ enum: CatalogKind })
  @IsOptional()
  @IsEnum(CatalogKind, {
    message:
      'El tipo debe ser diagnóstico (DIAGNOSIS) o procedimiento (PROCEDURE).',
  })
  kind?: CatalogKind;

  @ApiPropertyOptional({ description: 'Solo los ítems activos.' })
  @IsOptional()
  @IsBoolean({ message: '«Solo activos» debe ser verdadero o falso.' })
  activeOnly?: boolean;

  @ApiPropertyOptional({
    description:
      'Solo si el precio por defecto es MENOR que este importe (los ítems sin precio no entran).',
    maximum: MONEY_MAX,
  })
  @IsOptional()
  @IsPositiveMoney(
    '«Solo si el precio es menor que» debe ser un importe mayor que 0.',
  )
  priceBelow?: number;

  @ApiProperty({
    enum: MODES,
    description: 'PERCENT = porcentaje; AMOUNT = importe fijo.',
  })
  @IsIn(MODES, {
    message:
      'El tipo de cambio debe ser porcentaje (PERCENT) o importe (AMOUNT).',
  })
  mode!: PriceChangeMode;

  @ApiProperty({
    description:
      'Con signo: +5 sube un 5 % (o 5 unidades), −10 baja. Distinto de 0; un % entre −100 y 1000.',
  })
  @IsNumber({}, { message: 'El cambio debe ser un número.' })
  @IsBoundedDecimal({ maxDecimals: 2, maxAbs: MONEY_MAX, subject: 'El cambio' })
  value!: number;

  @ApiPropertyOptional({
    enum: PRICE_CHANGE_ROUNDING_UNITS,
    nullable: true,
    description:
      'Redondea al múltiplo más cercano de 1, 10, 100 o 1.000 unidades de la moneda del catálogo. Sin él (o null), a céntimos.',
  })
  @IsOptional()
  @IsIn(PRICE_CHANGE_ROUNDING_UNITS, {
    message:
      'El redondeo debe ser a 1, 10, 100 o 1.000 unidades (o sin redondeo).',
  })
  roundTo?: number | null;

  @ApiPropertyOptional({
    description:
      'Solo en subidas: lo mínimo que sube cada precio (si el cambio sube menos, sube esto, redondeado hacia arriba).',
    maximum: MONEY_MAX,
  })
  @IsOptional()
  @IsPositiveMoney('El incremento mínimo debe ser un importe mayor que 0.')
  minIncrement?: number;
}

export class ApplyCatalogPriceChangeDto extends CatalogPriceChangeDto {
  @ApiProperty({
    description: 'La huella (`previewHash`) que devolvió la vista previa.',
    pattern: '^[0-9a-f]{64}$',
  })
  @IsString({ message: 'Falta la huella de la vista previa.' })
  @Matches(/^[0-9a-fA-F]{64}$/, {
    message: 'La huella de la vista previa no es válida: vuelve a abrirla.',
  })
  previewHash!: string;
}

export class CatalogPriceChangeItemDto {
  @ApiProperty({ format: 'uuid' })
  itemId!: string;
  @ApiProperty()
  code!: string;
  @ApiProperty()
  labelEs!: string;
  @ApiProperty({ type: String, nullable: true })
  category!: string | null;
  @ApiProperty({ enum: CatalogKind })
  kind!: CatalogKind;
  @ApiProperty()
  active!: boolean;
}

export class CatalogPriceChangeLineDto extends CatalogPriceChangeItemDto {
  @ApiProperty({ description: 'Precio por defecto de ahora.' })
  before!: number;
  @ApiProperty({ description: 'Precio nuevo.' })
  after!: number;
  @ApiProperty({ description: 'after − before.' })
  difference!: number;
}

export class CatalogPriceChangeSkipDto extends CatalogPriceChangeItemDto {
  @ApiProperty({ type: Number, nullable: true })
  before!: number | null;
  @ApiProperty({
    enum: SKIP_REASONS,
    description:
      'NO_PRICE: sin precio por defecto; UNCHANGED: el precio nuevo es el mismo (p. ej. por el redondeo); OUT_OF_RANGE: pasaría del máximo.',
  })
  reason!: PriceChangeSkipReason;
}

export class CatalogPriceChangeTotalsDto {
  @ApiProperty()
  before!: number;
  @ApiProperty()
  after!: number;
  @ApiProperty()
  difference!: number;
}

export class CatalogPriceChangePreviewDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Moneda del catálogo (null si la clínica no la tiene definida).',
  })
  currency!: string | null;
  @ApiProperty({ description: 'Huella que exige `/apply`.' })
  previewHash!: string;
  @ApiProperty({ type: [CatalogPriceChangeLineDto] })
  lines!: CatalogPriceChangeLineDto[];
  @ApiProperty({ type: [CatalogPriceChangeSkipDto] })
  skipped!: CatalogPriceChangeSkipDto[];
  @ApiProperty({ type: CatalogPriceChangeTotalsDto })
  totals!: CatalogPriceChangeTotalsDto;
}

export class AppliedCatalogPriceChangeDto {
  @ApiProperty({ format: 'uuid' })
  batchId!: string;
  @ApiProperty({ format: 'date-time' })
  appliedAt!: string;
  @ApiProperty({
    description:
      'true si es la repetición de un lote ya aplicado con la misma Idempotency-Key (no cambió nada).',
  })
  replayed!: boolean;
  @ApiProperty({ type: String, nullable: true })
  currency!: string | null;
  @ApiProperty()
  itemCount!: number;
  @ApiProperty({ type: CatalogPriceChangeTotalsDto })
  totals!: CatalogPriceChangeTotalsDto;
}

export class CatalogPriceHistoryEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
  @ApiProperty({ type: Number, nullable: true })
  previousPrice!: number | null;
  @ApiProperty({ type: Number, nullable: true })
  newPrice!: number | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'El lote de «Actualizar precios»; null = edición suelta.',
  })
  batchId!: string | null;
  @ApiProperty({ format: 'uuid' })
  actorUserId!: string;
  @ApiProperty()
  actorName!: string;
  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}
