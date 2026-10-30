import { ApiProperty } from '@nestjs/swagger';
import { ExchangeRateSource } from '@prisma/client';
import { IsIn } from 'class-validator';
import {
  EXCHANGE_RATE_SOURCES,
  EXCHANGE_RATE_SOURCE_MESSAGE,
} from '../../domain/exchange-rate-source';

/** Cuerpo de PUT /exchange/settings (DX-374): la fuente, igual en todas las sedes. */
export class UpdateExchangeRateSettingsDto {
  @ApiProperty({
    enum: ExchangeRateSource,
    enumName: 'ExchangeRateSource',
    example: 'MANUAL',
    description:
      'AUTOMATIC: la tasa del día sale del proveedor (por defecto). MANUAL: desde hoy, la que registra la clínica para cada día y moneda; sin ella, la moneda queda «sin tasa». Los días anteriores al paso a MANUAL siguen con la automática.',
  })
  @IsIn(EXCHANGE_RATE_SOURCES, { message: EXCHANGE_RATE_SOURCE_MESSAGE })
  source!: ExchangeRateSource;
}

/** Tasa de cambio de la clínica (DX-374). */
export class ExchangeRateSettingsDto extends UpdateExchangeRateSettingsDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-10-30',
    description:
      'Día civil (sede principal) desde el que rige la fuente MANUAL: los días anteriores se convierten con la tasa automática. Null con AUTOMATIC.',
  })
  manualSince!: string | null;

  @ApiProperty({
    example: 'USD',
    description:
      'Moneda base de las tasas: cada tasa son unidades de la moneda por 1 de esta. No lleva tasa propia.',
  })
  baseCurrency!: string;
}
