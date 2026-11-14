import { ApiProperty } from '@nestjs/swagger';
import { ExchangeRateSource } from '@prisma/client';

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
      'DX-374: de dónde salen las tasas para la clínica: AUTOMATIC (el proveedor) o MANUAL (las que registró la clínica para ese día).',
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
}
