import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import {
  MAJORITY_AGE_MAX,
  MAJORITY_AGE_MESSAGE,
  MAJORITY_AGE_MIN,
} from '../../domain/responsible-parties/majority-age';

/** Ajustes de pacientes de la clínica (DX-328). */
export class PatientSettingsDto {
  @ApiProperty({
    minimum: MAJORITY_AGE_MIN,
    maximum: MAJORITY_AGE_MAX,
    example: 18,
    description:
      'Edad desde la que el paciente es adulto en esta clínica (Ajustes › Mayoría de edad).',
  })
  @IsInt({ message: MAJORITY_AGE_MESSAGE })
  @Min(MAJORITY_AGE_MIN, { message: MAJORITY_AGE_MESSAGE })
  @Max(MAJORITY_AGE_MAX, { message: MAJORITY_AGE_MESSAGE })
  majorityAge!: number;
}
