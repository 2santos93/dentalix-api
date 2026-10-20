import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

/** `GET`/`PUT /staff/:userId/locations` (DX-089). */
export class StaffLocationsDto {
  @ApiProperty({
    description:
      'true = sin restricción: trabaja en todas las sedes (siempre en un ADMIN) y `locationIds` va vacío',
  })
  all!: boolean;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'Sedes activas en las que puede trabajar. Con `all: false` y vacío, sus sedes ya no están activas',
  })
  locationIds!: string[];
}

/** Cuerpo de `PUT /staff/:userId/locations`. */
export class ReplaceStaffLocationsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    maxItems: 50,
    description:
      'Sedes activas de esta clínica. [] = todas. Los duplicados se ignoran',
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true, message: 'Alguna sede no es válida.' })
  locationIds!: string[];
}
