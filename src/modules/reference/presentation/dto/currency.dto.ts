import { ApiProperty } from '@nestjs/swagger';

export class CurrencyDto {
  @ApiProperty({ type: String, description: 'Código ISO 4217 de 3 letras.' })
  code!: string;

  @ApiProperty({ type: String, example: 'Euro' })
  name!: string;

  @ApiProperty({ type: String, example: '€' })
  symbol!: string;
}
