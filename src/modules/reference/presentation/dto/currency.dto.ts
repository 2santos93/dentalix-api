import { ApiProperty } from '@nestjs/swagger';

/**
 * DX-340: los decimales de una moneda. Dos números distintos (README «Redondeo
 * de importes»); ninguno es el de formato (CLDR), que la web lleva fijado.
 */
export class CurrencyDigitsDto {
  @ApiProperty({
    type: Number,
    minimum: 0,
    maximum: 2,
    example: 2,
    description:
      'Minor units de ISO 4217 según la List One de SIX (RSD 2, JPY 0). Dato normativo; no se usa para redondear.',
  })
  minorUnits!: number;

  @ApiProperty({
    type: Number,
    minimum: 0,
    maximum: 2,
    example: 0,
    description:
      'Decimales a los que Dentalix redondea cada línea (descuento en bloque, precio por convenio); el total de un documento es la suma de sus líneas. Puede ser menor que minorUnits (RSD, COP: 0).',
  })
  roundingDigits!: number;
}

export class CurrencyDto extends CurrencyDigitsDto {
  @ApiProperty({ type: String, description: 'Código ISO 4217 de 3 letras.' })
  code!: string;

  @ApiProperty({ type: String, example: 'Euro' })
  name!: string;

  @ApiProperty({ type: String, example: '€' })
  symbol!: string;
}
