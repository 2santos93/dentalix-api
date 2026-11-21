import { ApiProperty } from '@nestjs/swagger';
import { ExchangeRateSource } from '@prisma/client';

/** Una fila del indicador del menú (DX-584): «1 {currency} = {perReference} {reference}». */
export class ExchangeHeaderRateDto {
  @ApiProperty({ description: 'Moneda aceptada (ISO 4217).' })
  currency!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 918.77,
    description:
      'Unidades de la moneda de referencia por 1 de `currency`, cruzadas vía USD con las tasas del día (hasta 8 decimales). null = sin tasa (proveedor sin la del día, o MANUAL sin tasa registrada dentro del plazo).',
  })
  perReference!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '$',
    description:
      'Texto propio de `currency` (DX-517); null = se muestra el código ISO.',
  })
  label!: string | null;

  @ApiProperty({
    enum: ExchangeRateSource,
    enumName: 'ExchangeRateSource',
    description:
      'De dónde sale la tasa (la fuente de la clínica): AUTOMATIC (proveedor), MANUAL o BCV (DX-585: VES y EUR del BCV, el resto del proveedor).',
  })
  source!: ExchangeRateSource;

  @ApiProperty({
    example: '2026-11-21',
    description:
      'Día civil (AAAA-MM-DD) de la tasa: hoy en la sede activa o, con MANUAL y el plazo de DX-384, el último día anterior con tasa registrada.',
  })
  date!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Con AUTOMATIC, cuándo se guardó la tasa del proveedor. Con BCV, cuándo se consultó la tasa del BCV si la fila usa VES o EUR (si no, la del proveedor). null con MANUAL o sin tasa.',
  })
  fetchedAt!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-11-24',
    description:
      'DX-585: con BCV y una fila que usa VES o EUR (como moneda o como referencia), la «Fecha Valor» (AAAA-MM-DD) de la tasa del BCV: la más reciente que no es posterior a `date` (un fin de semana o feriado, la del último día hábil). null en cualquier otro caso.',
  })
  valueDate!: string | null;
}

/** Respuesta de GET /exchange/header (DX-584). */
export class ExchangeHeaderDto {
  @ApiProperty({
    description:
      'Si el menú enseña el indicador. false con «Nunca», sin sede utilizable, sin moneda de referencia o sin ninguna moneda que enseñar (en automático: ninguna aceptada distinta de la de referencia).',
  })
  visible!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Moneda de referencia: la de la clínica o, sin ella, la de la sede activa (o la principal).',
  })
  reference!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Bs.',
    description:
      'Texto propio de la de referencia (DX-517); null = el código ISO (y siempre null con `visible: false`).',
  })
  referenceLabel!: string | null;

  @ApiProperty({
    type: [ExchangeHeaderRateDto],
    description:
      'Una fila por moneda aceptada distinta de la de referencia, en el orden de la clínica. Vacía con `visible: false`.',
  })
  rates!: ExchangeHeaderRateDto[];

  @ApiProperty({
    type: [String],
    example: ['USD', 'VES'],
    description:
      'Monedas en que la clínica acepta cobros, en su orden (vacía = cualquiera): para filtrar el selector de moneda del cobro con cualquier rol. Va siempre, también con `visible: false`.',
  })
  acceptedCurrencies!: string[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Cuándo se calculó la respuesta.',
  })
  updatedAt!: string;
}
