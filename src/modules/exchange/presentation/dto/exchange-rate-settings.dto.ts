import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ExchangeRateSource } from '@prisma/client';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  MANUAL_RATE_MAX_AGE_MAX,
  MANUAL_RATE_MAX_AGE_MESSAGE,
  MANUAL_RATE_MAX_AGE_MIN,
} from '../../domain/manual-rate-fallback';
import {
  EXCHANGE_RATE_SOURCES,
  EXCHANGE_RATE_SOURCE_MESSAGE,
} from '../../domain/exchange-rate-source';

const MAX_AGE_DESCRIPTION =
  'DX-384. Con fuente MANUAL, hasta cuántos días de antigüedad puede tener la última tasa manual registrada que se usa cuando no hay tasa del día del abono (día civil de su sede). 0 = solo la tasa del mismo día. El abono congela esa tasa con su fecha; registrar después la del día no la cambia. Pasado el plazo, el abono queda «sin tasa». 3 por defecto en una clínica nueva; en el PUT, sin este campo el plazo no cambia.';

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
}
