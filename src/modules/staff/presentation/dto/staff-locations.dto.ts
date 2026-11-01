import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';

/** `GET`/`PUT /staff/:userId/locations` (DX-089). */
export class StaffLocationsDto {
  @ApiProperty({
    example: false,
    description:
      'true = sin restricción: trabaja en todas las sedes (siempre en un ADMIN) y `locationIds` va vacío',
  })
  all!: boolean;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    example: ['c6a90d5a-9b1c-4b1e-8e41-d3125c016078'],
    description:
      'Sedes activas en las que puede trabajar. Con `all: false` y vacío, sus sedes ya no están activas',
  })
  locationIds!: string[];
}

/** Cuerpo de `PUT /staff/:userId/locations`, tras invitar al miembro. */
export class ReplaceStaffLocationsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    example: ['c6a90d5a-9b1c-4b1e-8e41-d3125c016078'],
    maxItems: 50,
    description:
      'Sedes activas de esta clínica. [] = todas. Los duplicados se ignoran. ' +
      'Se asignan con PUT /staff/:userId/locations tras la invitación; ' +
      'crear invitaciones y PATCH /staff/:userId no aceptan locationIds',
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true, message: 'Alguna sede no es válida.' })
  locationIds!: string[];
}
