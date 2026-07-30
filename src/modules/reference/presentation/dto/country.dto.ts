import { ApiProperty } from '@nestjs/swagger';

export class CountryDto {
  @ApiProperty({ example: 'CO' })
  code!: string;

  @ApiProperty({ example: 'Colombia' })
  name!: string;
}
