import { ApiProperty } from '@nestjs/swagger';

export class CityDto {
  @ApiProperty({ example: 12345 })
  id!: number;

  @ApiProperty({ description: 'Nombre de la ciudad.' })
  name!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Región, provincia o estado de la ciudad, si lo hay.',
  })
  region!: string | null;
}
