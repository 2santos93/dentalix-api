import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsUUID,
  Matches,
} from 'class-validator';
import { PriceSource } from '@prisma/client';
import { ReferenceRateDto } from '../../../discounts/presentation/dto/reference-rate.dto';
import { REPRICING_SKIP_REASONS } from '../../application/repricing';

export const REPRICE_MAX_ITEMS = 100;

/** Cuerpo de `POST …/reprice/preview`. */
export class RepricePlanDto {
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: REPRICE_MAX_ITEMS,
    description:
      'Ítems vivos de ESTE plan a recotizar (404 si alguno no lo es; 409 si alguno no está propuesto o es un cargo por inasistencia). Sin ellos (o vacío), todos los propuestos; el resto sale en `skipped`.',
  })
  @IsOptional()
  @IsArray({ message: 'Los ítems tienen que ser una lista.' })
  @ArrayMaxSize(REPRICE_MAX_ITEMS, {
    message: `Elige como mucho ${REPRICE_MAX_ITEMS} ítems.`,
  })
  @IsUUID('all', { each: true, message: 'Cada ítem debe ser un UUID.' })
  itemIds?: string[];
}

/** Cuerpo de `POST …/reprice/apply`. */
export class ApplyRepricingDto extends RepricePlanDto {
  @ApiProperty({
    pattern: '^[0-9a-f]{64}$',
    description:
      'La huella (`previewHash`) que devolvió la vista previa. Si los precios vigentes, la tasa, los ítems o la validez cambiaron desde entonces, 409 `REPRICE_PREVIEW_STALE` y nada cambia.',
  })
  @Matches(/^[0-9a-fA-F]{64}$/, {
    message:
      'La huella de la vista previa no es válida: vuelve a abrir la vista previa.',
  })
  previewHash!: string;
}

/** El precio de un ítem a un lado de la recotización. */
export class RepricingPriceDto {
  @ApiProperty({ description: 'Precio del ítem, en la moneda del plan.' })
  price!: number;

  @ApiProperty({ description: 'Descuento del ítem, en la moneda del plan.' })
  discount!: number;

  @ApiProperty({ description: 'Importe de la línea: precio − descuento.' })
  total!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Precio de lista (la referencia) en la moneda del plan; null en un ítem libre o anterior sin foto.',
  })
  listPrice!: number | null;

  @ApiProperty({
    enum: PriceSource,
    enumName: 'PriceSource',
    nullable: true,
    description: 'De dónde sale la referencia; null en un ítem libre.',
  })
  priceSource!: PriceSource | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  agreementId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  agreementName!: string | null;
}

export class RepricingLineDto {
  @ApiProperty({ format: 'uuid' })
  itemId!: string;

  @ApiProperty({ format: 'uuid' })
  catalogItemId!: string;

  @ApiProperty({ description: 'Pieza (FDI); vacía en un ítem sin pieza.' })
  toothNumber!: string;

  @ApiProperty({ type: RepricingPriceDto, description: 'Cómo está ahora.' })
  before!: RepricingPriceDto;

  @ApiProperty({
    type: RepricingPriceDto,
    description:
      'Cómo queda con el precio vigente (D-4: guarda la proporción precio / lista y descuento / precio, redondeado una vez a la moneda del plan).',
  })
  after!: RepricingPriceDto;

  @ApiProperty({
    description: 'after.total − before.total (puede ser negativa o 0).',
  })
  difference!: number;

  @ApiProperty({
    description:
      'false = el precio y su foto no cambian (se aplica igual: la validez se reinicia).',
  })
  changed!: boolean;
}

export class RepricingSkipDto {
  @ApiProperty({ format: 'uuid' })
  itemId!: string;

  @ApiProperty({ format: 'uuid' })
  catalogItemId!: string;

  @ApiProperty()
  toothNumber!: string;

  @ApiProperty({
    enum: REPRICING_SKIP_REASONS,
    enumName: 'RepricingSkipReason',
    description:
      'NOT_PROPOSED: aceptado, realizado o descartado. CANCELLATION_FEE: cargo vigente por inasistencia. NO_CURRENT_PRICE: el procedimiento no tiene precio vigente (o es 0, o ya no está en el catálogo): no se pone a 0. NO_RATE: el precio vigente está en otra moneda y no hay tasa de hoy (`currency`).',
  })
  reason!: (typeof REPRICING_SKIP_REASONS)[number];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Con NO_RATE, la moneda sin tasa; null en el resto.',
  })
  currency!: string | null;
}

export class RepricingRateDto extends ReferenceRateDto {
  @ApiProperty({
    description:
      'Moneda del catálogo (de la que se convirtió) en ISO 4217; `fromPerBase` es de esta moneda.',
  })
  currency!: string;
}

export class RepricingValidityDto {
  @ApiProperty({
    example: '2026-11-09',
    description: 'Día de emisión (AAAA-MM-DD, día civil de la sede del plan).',
  })
  issuedOn!: string;

  @ApiProperty({
    example: '2026-12-09',
    description: 'Último día válido (AAAA-MM-DD, inclusive).',
  })
  validUntil!: string;
}

export class RepricingTotalsDto {
  @ApiProperty({
    description: 'Total del plan (todas sus líneas vivas) ahora.',
  })
  before!: number;

  @ApiProperty({ description: 'Total del plan recotizado.' })
  after!: number;

  @ApiProperty({ description: 'after − before.' })
  difference!: number;
}

/** Respuesta de `POST …/reprice/preview`. */
export class RepricingPreviewDto {
  @ApiProperty({ format: 'uuid' })
  planId!: string;

  @ApiProperty({ description: 'Moneda del plan (ISO 4217).' })
  currency!: string;

  @ApiProperty({
    pattern: '^[0-9a-f]{64}$',
    description:
      'SHA-256 de lo que se aplicaría (líneas antes y después, saltados, tasa y validez nueva): se manda tal cual a `/reprice/apply`.',
  })
  previewHash!: string;

  @ApiProperty({
    type: [RepricingLineDto],
    description: 'Ítems que se recotizan (por id).',
  })
  lines!: RepricingLineDto[];

  @ApiProperty({
    type: [RepricingSkipDto],
    description: 'Ítems que no se tocan y por qué (por id).',
  })
  skipped!: RepricingSkipDto[];

  @ApiProperty({
    type: RepricingRateDto,
    nullable: true,
    description:
      'La tasa de hoy usada (de la moneda del catálogo a la del plan); null si no hizo falta convertir.',
  })
  rate!: RepricingRateDto | null;

  @ApiProperty({
    type: RepricingValidityDto,
    nullable: true,
    description:
      'La validez guardada antes de recotizar; null si el plan no tenía (borrador nunca emitido).',
  })
  previousValidity!: RepricingValidityDto | null;

  @ApiProperty({
    description:
      'true = se recotizan TODOS los ítems propuestos vivos del plan y la validez se renueva (emitido hoy en la sede del plan + días del ajuste). false = selección parcial o algún propuesto saltado (sin precio vigente o sin tasa): la validez no cambia.',
  })
  validityRenewed!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Con `validityRenewed: false`, por qué, para la pantalla («Quedan ítems con precios anteriores: la validez no se renueva.»); null si se renueva.',
  })
  validityNote!: string | null;

  @ApiProperty({
    type: RepricingValidityDto,
    nullable: true,
    description:
      'La validez con la que queda el plan: la nueva si `validityRenewed`, si no la que ya tenía (null en un borrador nunca emitido).',
  })
  validity!: RepricingValidityDto | null;

  @ApiProperty({ type: RepricingTotalsDto })
  totals!: RepricingTotalsDto;
}

/** Respuesta de `POST …/reprice/apply`. */
export class AppliedRepricingDto extends RepricingPreviewDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'La recotización guardada (`treatment_plan_repricings`); la auditoría la enlaza en `params.repricingId`.',
  })
  repricingId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  appliedAt!: string;

  @ApiProperty({
    description:
      'true = repetición con la misma Idempotency-Key: devuelve lo ya aplicado, sin volver a escribir.',
  })
  replayed!: boolean;
}
