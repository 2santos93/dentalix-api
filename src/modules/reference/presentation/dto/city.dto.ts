import { ApiProperty } from '@nestjs/swagger';

export class CityDto {
  @ApiProperty({ example: 12345 })
  id!: number;

  @ApiProperty({ example: 'Bogotá' })
  name!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Bogota D.C.' })
  region!: string | null;
}
