import { ApiProperty } from '@nestjs/swagger';

// DX-312: sin ejemplo, como el país de la sede (`COUNTRY_DOC`): un país
// concreto se leería como el país por defecto del producto.
export class CountryDto {
  @ApiProperty({
    minLength: 2,
    maxLength: 2,
    description: 'Código ISO 3166-1 alfa-2.',
  })
  code!: string;

  @ApiProperty({ description: 'Nombre del país en español (CLDR).' })
  name!: string;
}
