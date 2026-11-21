import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  EXCHANGE_RATE_SOURCES,
  type ExchangeRateSource,
} from '../../../exchange/domain/exchange-rate-source';

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
      'AUTOMATIC: la del proveedor; MANUAL: la que registró la clínica (para ese día o, DX-384, la última dentro del plazo de la clínica); BCV (DX-585): VES y EUR de la tasa oficial del BCV que regía ese día, el resto del proveedor',
  })
  source!: ExchangeRateSource;

  @ApiProperty({
    example: '2026-10-30',
    description:
      'Día civil (AAAA-MM-DD) de la tasa USADA. Es el del abono en su sede salvo con fuente MANUAL cuando la clínica no registró la de ese día y se usó la última dentro de su plazo (DX-384, `manualRateMaxAgeDays`): entonces es anterior al del abono. Se congela con el abono: registrar después la tasa del día no lo cambia.',
  })
  date!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'BCV:2026-11-20',
    description:
      'DX-586: referencia estable a la tasa usada: `BCV:<fecha valor>`, `AUTOMATIC:<día>`, `MANUAL:<id de la tasa manual>` (dos unidas con «+» si las dos monedas no son USD) u `OVERRIDE:<día>` (la que fijó recepción). null en las tasas congeladas antes de DX-586.',
  })
  ref?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '2026-11-20',
    description:
      'DX-586: «Fecha Valor» del BCV de la tasa (solo con fuente BCV); null en las demás.',
  })
  valueDate?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'DX-586: cuándo se cotizó (hora de la BD al congelar: al registrar o en el barrido). null en las tasas congeladas antes de DX-586.',
  })
  quotedAt?: Date | null;
}

/**
 * DX-586: la tasa usada tal como se enseña: «1 {unit} = {rate} {currency}
 * ({fuente}, fecha valor …)». Solo en los abonos congelados desde DX-586.
 */
export class PaymentRateUsedDto {
  @ApiProperty({
    example: 918.77,
    description:
      'Unidades de `currency` por 1 `unit` (hasta 8 decimales). `unit` es la más fuerte de las dos monedas.',
  })
  rate!: number;

  @ApiProperty({
    description: 'La moneda de la que se da 1 (código ISO 4217).',
  })
  unit!: string;

  @ApiProperty({
    description: 'La moneda en que se da la tasa (código ISO 4217).',
  })
  currency!: string;

  @ApiProperty({
    enum: EXCHANGE_RATE_SOURCES,
    enumName: 'ExchangeRateSource',
  })
  source!: ExchangeRateSource;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-11-20',
    description: '«Fecha Valor» del BCV (solo con fuente BCV); si no, null.',
  })
  valueDate!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Cuándo se cotizó (hora de la BD al congelar).',
  })
  quotedAt!: string;

  @ApiProperty({
    example: 'BCV:2026-11-20',
    description:
      'Referencia estable a la tasa usada (ver `FrozenExchangeRateDto.ref`).',
  })
  ref!: string;
}

export const RATE_USED_DESCRIPTION =
  'DX-586: la tasa con que se cobró: qué tasa, de qué fuente, con qué fecha ' +
  'valor (BCV), cuándo se cotizó y su referencia. null si el abono no ' +
  'convierte, sigue «sin tasa» o congeló su tasa antes de DX-586 (esos no ' +
  'cambian).';
