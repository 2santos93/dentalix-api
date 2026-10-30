import { ApiProperty } from '@nestjs/swagger';
import { ExchangeRateSource } from '@prisma/client';
import { IsIn } from 'class-validator';
import {
  EXCHANGE_RATE_SOURCES,
  EXCHANGE_RATE_SOURCE_MESSAGE,
} from '../../domain/exchange-rate-source';

/** Fuente de la tasa de cambio de la clínica (DX-374): igual en todas sus sedes. */
export class ExchangeRateSettingsDto {
  @ApiProperty({
    enum: ExchangeRateSource,
    enumName: 'ExchangeRateSource',
    example: 'MANUAL',
    description:
      'AUTOMATIC: la tasa del día sale del proveedor (por defecto). MANUAL: la que registra la clínica para cada día y moneda; sin ella, la moneda queda «sin tasa».',
  })
  @IsIn(EXCHANGE_RATE_SOURCES, { message: EXCHANGE_RATE_SOURCE_MESSAGE })
  source!: ExchangeRateSource;
}
