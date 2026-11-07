import { ApiProperty } from '@nestjs/swagger';
import { EXCHANGE_RATE_SOURCES } from '../../../exchange/domain/exchange-rate-source';

/**
 * DX-513-bis: la tasa con que se convirtió la referencia de un ítem a la
 * moneda del plan, congelada al escribirlo (como la de un abono, DX-375).
 */
export class ReferenceRateDto {
  @ApiProperty({
    example: 880,
    description:
      'Unidades de la moneda de la referencia (`referenceCurrency`) por 1 USD.',
  })
  fromPerBase!: number;

  @ApiProperty({
    example: 1,
    description: 'Unidades de la moneda del plan por 1 USD.',
  })
  toPerBase!: number;

  @ApiProperty({
    enum: EXCHANGE_RATE_SOURCES,
    enumName: 'ExchangeRateSource',
    description:
      'De dónde salió la tasa: del proveedor o la manual de la clínica.',
  })
  source!: 'AUTOMATIC' | 'MANUAL';

  @ApiProperty({
    example: '2026-11-07',
    description:
      'Día civil (AAAA-MM-DD) de la tasa usada; con tasa manual puede ser anterior al del ítem (DX-384).',
  })
  rateDate!: string;
}
