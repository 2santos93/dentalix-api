import { ApiProperty } from '@nestjs/swagger';
import { EXCHANGE_RATE_SOURCES } from '../../../exchange/domain/exchange-rate-source';

export const EXCHANGE_RATE_STATUS_DESCRIPTION =
  'DX-375: la tasa del abono. NOT_NEEDED: está en la moneda de su destino. ' +
  'FROZEN: congeló su tasa al registrarse (o el barrido, si se cobró sin ' +
  'tasa) y saldos y totales la usan siempre, aunque la tasa cambie después. ' +
  'MISSING: «sin tasa»: no había tasa de su día; no cuenta en el saldo del ' +
  'plan hasta que se registre (Ajustes › Tasa de cambio) y el barrido de ' +
  'cada minuto la congele. LEGACY: anterior a la tasa congelada y aún sin ' +
  'congelar: se convierte con la tasa de su día, como antes, hasta que el ' +
  'barrido la congele.';

/** La tasa que congeló un abono (DX-375). */
export class FrozenExchangeRateDto {
  @ApiProperty({
    example: 'USD',
    description: 'Moneda de destino: la del plan (o la del saldo migrado)',
  })
  currency!: string;

  @ApiProperty({
    example: 4000,
    description:
      'Unidades de la moneda del abono por 1 USD, tal como las dio la fuente ese día (hasta 8 decimales)',
  })
  fromPerBase!: number;

  @ApiProperty({
    example: 1,
    description:
      'Unidades de `currency` por 1 USD, tal como las dio la fuente ese día (hasta 8 decimales)',
  })
  toPerBase!: number;

  @ApiProperty({
    enum: EXCHANGE_RATE_SOURCES,
    enumName: 'ExchangeRateSource',
    description:
      'AUTOMATIC: la del proveedor; MANUAL: la que registró la clínica para ese día',
  })
  source!: 'AUTOMATIC' | 'MANUAL';

  @ApiProperty({
    example: '2026-10-30',
    description: 'Día civil (AAAA-MM-DD) de la tasa: el del abono en su sede',
  })
  date!: string;
}
