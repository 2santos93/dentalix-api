import { ApiProperty } from '@nestjs/swagger';

export class CurrencyDto {
  @ApiProperty({ type: String, example: 'EUR' })
  code!: string;

  @ApiProperty({ type: String, example: 'Euro' })
  name!: string;

  @ApiProperty({ type: String, example: '€' })
  symbol!: string;
}
