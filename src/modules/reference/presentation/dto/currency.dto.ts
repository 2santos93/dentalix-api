import { ApiProperty } from '@nestjs/swagger';

export class CurrencyDto {
  @ApiProperty({ example: 'USD' })
  code!: string;

  @ApiProperty({ example: 'Dólar estadounidense' })
  name!: string;

  @ApiProperty({ example: '$' })
  symbol!: string;
}
