import { ApiProperty } from '@nestjs/swagger';

/** DX-339: la última copia nocturna de la agenda de contingencia de una sede. */
export class ContingencyNightlyInfoDto {
  @ApiProperty({
    description: 'Hay una copia nocturna guardada para la sede.',
  })
  available!: boolean;

  @ApiProperty({
    description:
      'La copia es la de HOY en la zona de la sede (cubre hoy y mañana). false si no hay copia o es de un día anterior.',
  })
  current!: boolean;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    example: '2026-11-02',
    description:
      '«Hoy» (día civil en la zona de la sede) al generarla: cubre ese día y el siguiente. null sin copia.',
  })
  forDate!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Cuándo se generó (UTC). null sin copia.',
  })
  generatedAt!: Date | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 18,
    description:
      'Citas que lleva (sin canceladas ni inasistencias). null sin copia.',
  })
  appointmentCount!: number | null;
}
