import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ExchangeRateSource } from '@prisma/client';

/** DX-585: de qué publicación del BCV salen VES y EUR. */
export class BcvRateInfoDto {
  @ApiProperty({
    example: '2026-11-24',
    description:
      '«Fecha Valor» (AAAA-MM-DD) de la tasa del BCV: la más reciente que no es posterior al día pedido (un fin de semana o feriado, la del último día hábil).',
  })
  valueDate!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Cuándo se consultó la tasa del BCV.',
  })
  fetchedAt!: string;
}

/** DX-586: una tasa manual que rige en `rates`, con su id y desde cuándo. */
export class ManualRateUsedDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ description: 'Código ISO 4217 de 3 letras.' })
  currency!: string;

  @ApiProperty({
    example: 918.77,
    description: 'Unidades de la moneda por 1 USD.',
  })
  rate!: number;

  @ApiProperty({ example: '2026-11-20', description: 'Día civil de la tasa.' })
  date!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Desde qué instante del día rige.',
  })
  effectiveFrom!: string;
}

// Response shape for GET /exchange/rates — documents the RatesForDate
// contract for Swagger (same convention as StaffMemberDto/PatientDto: the
// use case already returns values shaped exactly like this; this class
// exists purely for `@ApiProperty` documentation, not input validation).
export class RatesResponseDto {
  @ApiProperty({ enum: ['USD'] })
  base!: 'USD';

  @ApiProperty({
    enum: ExchangeRateSource,
    enumName: 'ExchangeRateSource',
    description:
      'DX-374: de dónde salen las tasas para la clínica: AUTOMATIC (el proveedor) o MANUAL (las que registró la clínica para ese día). DX-585: BCV: VES y EUR de la tasa oficial del BCV que rige ese día (ver `bcv`) y el resto del proveedor.',
  })
  source!: ExchangeRateSource;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    description:
      'Units of each currency per 1 USD, for the requested date, keyed by its ISO 4217 code (3 letters). Con fuente MANUAL solo trae las monedas con tasa registrada ese día: una moneda que NO aparece está «sin tasa» (no se inventa, no se toma la de otro día ni se pide al proveedor) y convertirla responde 400 EXCHANGE_RATE_MISSING.',
  })
  rates!: Record<string, number>;

  @ApiProperty({
    type: String,
    example: '2026-10-30',
    description:
      'DX-384: día civil (AAAA-MM-DD) de estas tasas. Es el pedido (`date`) salvo con fuente MANUAL cuando se pidieron `currencies` sin tasa ese día y se devuelve la última fecha anterior dentro del plazo de la clínica que las tiene todas. Nunca posterior a `date`.',
  })
  rateDate!: string;

  @ApiPropertyOptional({
    type: BcvRateInfoDto,
    nullable: true,
    description:
      'DX-585: solo con fuente BCV. La tasa del BCV de la que salen VES y EUR (como mucho 7 días anterior al día pedido); null si no hay ninguna y VES y EUR no aparecen en `rates` («sin tasa»). Con las otras fuentes no viene.',
  })
  bcv?: BcvRateInfoDto | null;

  @ApiPropertyOptional({
    type: [ManualRateUsedDto],
    description:
      'DX-586: solo con tasas manuales. Las que rigen en `rates`: por moneda, la de mayor `effectiveFrom` ≤ ahora del día `rateDate` (la última del día si es pasado). Es la tasa que congelaría un abono registrado ahora (`MANUAL:<id>`).',
  })
  manualRates?: ManualRateUsedDto[];

  @ApiPropertyOptional({
    type: [ManualRateUsedDto],
    description:
      'DX-586: solo con fuente MANUAL. Todas las tasas registradas para el día pedido (`date`), por moneda y hora (`effectiveFrom`), para la lista del día. Solo id, moneda, tasa, día y hora: ni el autor ni si un abono la usó (GET /exchange/manual-rates, solo ADMIN).',
  })
  manualDay?: ManualRateUsedDto[];
}
