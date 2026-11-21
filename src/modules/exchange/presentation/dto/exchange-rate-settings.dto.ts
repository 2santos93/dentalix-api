import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ExchangeRateSource } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { CURRENCY_CODE_MESSAGE } from '../../../../shared/money/currency-messages';
import {
  ACCEPTED_CURRENCIES_MAX,
  ACCEPTED_CURRENCIES_TOO_MANY_MESSAGE,
} from '../../domain/clinic-currencies';
import {
  MANUAL_RATE_MAX_AGE_MAX,
  MANUAL_RATE_MAX_AGE_MESSAGE,
  MANUAL_RATE_MAX_AGE_MIN,
} from '../../domain/manual-rate-fallback';
import {
  EXCHANGE_RATE_SOURCES,
  EXCHANGE_RATE_SOURCE_MESSAGE,
} from '../../domain/exchange-rate-source';

const CURRENCY_CODE = /^[A-Za-z]{3}$/;

const ACCEPTED_DESCRIPTION = `DX-584. Monedas en que la clínica acepta cobros (ISO 4217 de la lista de monedas, sin repetidas, de 0 a ${ACCEPTED_CURRENCIES_MAX}), en el orden en que el menú las enseña. Vacía = cualquier moneda (lo de antes). Con alguna, registrar un abono (suelto, dividido o las líneas del vuelto) en otra moneda da 400 \`CURRENCY_NOT_ACCEPTED\`; los abonos ya registrados no cambian.`;
const REFERENCE_DESCRIPTION =
  'DX-584. Moneda contra la que el menú muestra las equivalencias («1 USD = N Bs.»). Tiene que ser una de las aceptadas o la moneda de alguna sede. null = la de la sede activa.';
const SHOW_DESCRIPTION =
  'DX-584. Mostrar la tasa en el menú: null = automático (si hay alguna moneda aceptada distinta de la de referencia), true = siempre (sin monedas aceptadas, enseña la del USD), false = nunca.';

const MAX_AGE_DESCRIPTION =
  'DX-384. Con fuente MANUAL, hasta cuántos días de antigüedad puede tener la última tasa manual registrada que se usa cuando no hay tasa del día del abono (día civil de su sede). 0 = solo la tasa del mismo día. El abono congela esa tasa con su fecha; registrar después la del día no la cambia. Pasado el plazo, el abono queda «sin tasa». Nunca se usa una tasa anterior a `manualSince` (esas son el respaldo de DX-402 de su propio día). 3 por defecto en una clínica nueva; en el PUT, sin este campo el plazo no cambia.';

/**
 * Cuerpo de PUT /exchange/settings (DX-374 y DX-384): la fuente y/o el plazo de
 * la última tasa registrada, iguales en todas las sedes. Al menos uno.
 */
export class UpdateExchangeRateSettingsDto {
  @ApiPropertyOptional({
    enum: ExchangeRateSource,
    enumName: 'ExchangeRateSource',
    example: 'MANUAL',
    description:
      'AUTOMATIC: la tasa del día sale del proveedor (por defecto). MANUAL: desde hoy, la que registra la clínica para cada día y moneda; sin ella, la moneda queda «sin tasa» (salvo el plazo de `manualRateMaxAgeDays`). Los días anteriores al paso a MANUAL siguen con la automática. Sin este campo la fuente no cambia.',
  })
  @IsOptional()
  @IsIn(EXCHANGE_RATE_SOURCES, { message: EXCHANGE_RATE_SOURCE_MESSAGE })
  source?: ExchangeRateSource;

  @ApiPropertyOptional({
    type: Number,
    minimum: MANUAL_RATE_MAX_AGE_MIN,
    maximum: MANUAL_RATE_MAX_AGE_MAX,
    example: 3,
    description: MAX_AGE_DESCRIPTION,
  })
  @IsOptional()
  @IsInt({ message: MANUAL_RATE_MAX_AGE_MESSAGE })
  @Min(MANUAL_RATE_MAX_AGE_MIN, { message: MANUAL_RATE_MAX_AGE_MESSAGE })
  @Max(MANUAL_RATE_MAX_AGE_MAX, { message: MANUAL_RATE_MAX_AGE_MESSAGE })
  manualRateMaxAgeDays?: number;

  @ApiPropertyOptional({
    type: [String],
    maxItems: ACCEPTED_CURRENCIES_MAX,
    example: ['USD', 'VES'],
    description: `${ACCEPTED_DESCRIPTION} Sin este campo no cambian; \`[]\` las quita todas.`,
  })
  // null no vale (no es «sin cambiar» ni «vacía»): solo se salta si no llega.
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ message: CURRENCY_CODE_MESSAGE })
  @ArrayMaxSize(ACCEPTED_CURRENCIES_MAX, {
    message: ACCEPTED_CURRENCIES_TOO_MANY_MESSAGE,
  })
  @IsString({ each: true, message: CURRENCY_CODE_MESSAGE })
  @Matches(CURRENCY_CODE, { each: true, message: CURRENCY_CODE_MESSAGE })
  acceptedCurrencies?: string[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: `${REFERENCE_DESCRIPTION} Sin este campo no cambia.`,
  })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString({ message: CURRENCY_CODE_MESSAGE })
  @Matches(CURRENCY_CODE, { message: CURRENCY_CODE_MESSAGE })
  rateReferenceCurrency?: string | null;

  @ApiPropertyOptional({
    type: Boolean,
    nullable: true,
    example: null,
    description: `${SHOW_DESCRIPTION} Sin este campo no cambia.`,
  })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsBoolean({ message: 'Elige automático, siempre o nunca.' })
  showRateInHeader?: boolean | null;
}

/** Tasa de cambio de la clínica (DX-374). */
export class ExchangeRateSettingsDto {
  @ApiProperty({
    enum: ExchangeRateSource,
    enumName: 'ExchangeRateSource',
    example: 'MANUAL',
    description:
      'De dónde sale la tasa del día: AUTOMATIC (proveedor) o MANUAL (la que registra la clínica).',
  })
  source!: ExchangeRateSource;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-10-30',
    description:
      'Día civil (sede principal) desde el que rige la fuente MANUAL: los días anteriores se convierten con la tasa automática. Null con AUTOMATIC.',
  })
  manualSince!: string | null;

  @ApiProperty({
    type: Number,
    minimum: MANUAL_RATE_MAX_AGE_MIN,
    maximum: MANUAL_RATE_MAX_AGE_MAX,
    example: 3,
    description: MAX_AGE_DESCRIPTION,
  })
  manualRateMaxAgeDays!: number;

  @ApiProperty({
    description:
      'Moneda base de las tasas: cada tasa son unidades de la moneda por 1 de esta. No lleva tasa propia.',
  })
  baseCurrency!: string;

  @ApiProperty({
    type: [String],
    example: ['USD', 'VES'],
    description: ACCEPTED_DESCRIPTION,
  })
  acceptedCurrencies!: string[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: REFERENCE_DESCRIPTION,
  })
  rateReferenceCurrency!: string | null;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    example: null,
    description: SHOW_DESCRIPTION,
  })
  showRateInHeader!: boolean | null;
}
