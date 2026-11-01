import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Equals, IsInt, IsOptional } from 'class-validator';

/** Ventana de corrección de 24 h tras una subida del plazo (DX-330, R13). */
export class RetentionCorrectionWindowDto {
  @ApiProperty({
    description:
      'Plazo vigente justo antes de la subida: volver a él, o a uno mayor, no fija ninguna fecha.',
  })
  previousYears!: number;

  @ApiProperty({
    format: 'date-time',
    description: 'Instante en que la ventana se cierra (subida + 24 h).',
  })
  until!: string;
}

/** Plazo de conservación de la historia clínica de la clínica (DX-330). */
export class RetentionSettingsDto {
  @ApiProperty({
    description:
      'Plazo guardado por la clínica, en años. El que rige es `effectiveYears`.',
  })
  clinicalRecordRetentionYears!: number;

  @ApiProperty({
    description:
      'Plazo que rige: el guardado, nunca por debajo del mínimo de plataforma.',
  })
  effectiveYears!: number;

  @ApiProperty({ description: 'Mínimo de plataforma, en años.' })
  platformMinimumYears!: number;

  @ApiProperty({ description: 'Máximo que admite la clínica, en años.' })
  maximumYears!: number;

  @ApiProperty({
    type: RetentionCorrectionWindowDto,
    nullable: true,
    description:
      'Presente durante las 24 horas siguientes a una subida; null si no hay ventana abierta.',
  })
  correctionWindow!: RetentionCorrectionWindowDto | null;
}

export class RetentionSettingsUpdateResultDto extends RetentionSettingsDto {
  @ApiProperty({
    minimum: 0,
    description:
      'Historias en retención que mantienen una fecha de fin anterior tras una reducción; 0 si no hubo reducción.',
  })
  protectedPatients!: number;
}

export class UpdateRetentionSettingsDto {
  @ApiProperty({
    example: 20,
    description:
      'Plazo de conservación en años: entero entre el mínimo de plataforma y el máximo. El rango se valida en el caso de uso.',
  })
  @IsInt({
    message: 'El plazo de conservación tiene que ser un número entero de años.',
  })
  clinicalRecordRetentionYears!: number;

  @ApiPropertyOptional({
    enum: [true],
    description:
      'Confirma una reducción del plazo. Sin él, reducir responde 409 `RETENTION_REDUCTION_UNCONFIRMED` y no guarda nada. En una subida o sin cambio se ignora.',
  })
  @IsOptional()
  @Equals(true, { message: 'confirmReduction solo admite true.' })
  confirmReduction?: true;
}

/** Cuerpo del 409 `RETENTION_REDUCTION_UNCONFIRMED` (Swagger). */
export class RetentionReductionUnconfirmedErrorDto {
  @ApiProperty({ example: 409 })
  statusCode!: number;

  @ApiProperty({ example: 'RETENTION_REDUCTION_UNCONFIRMED' })
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiProperty({ description: 'Plazo vigente antes del cambio.' })
  previousYears!: number;

  @ApiProperty({ description: 'Plazo vigente tras el cambio.' })
  newYears!: number;

  @ApiProperty({
    minimum: 0,
    description: 'Historias que mantendrían una fecha de fin anterior.',
  })
  protectedPatients!: number;

  @ApiProperty({
    description: 'La reducción corrige una subida de hace menos de 24 horas.',
  })
  withinCorrectionWindow!: boolean;
}
