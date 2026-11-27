import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';
import {
  PERIO_COMPARE_MAX,
  PERIO_COMPARE_MIN,
} from '../../domain/perio-comparison';

const COUNT_MESSAGE = `Elige entre ${PERIO_COMPARE_MIN} y ${PERIO_COMPARE_MAX} exámenes para comparar`;

/** `?examIds=a,b` o `?examIds=a&examIds=b` → lista de ids sin espacios. */
function toIdList({ value }: { value: unknown }): unknown {
  const parts = Array.isArray(value) ? value : [value];
  if (!parts.every((p) => typeof p === 'string')) return value;
  return parts
    .flatMap((p) => p.split(','))
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

/** DX-066: exámenes a comparar. */
export class ComparePerioExamsQueryDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: PERIO_COMPARE_MIN,
    maxItems: PERIO_COMPARE_MAX,
    description: `De ${PERIO_COMPARE_MIN} a ${PERIO_COMPARE_MAX} exámenes FINAL del paciente, separados por comas (?examIds=a,b,c) o repitiendo el parámetro. El orden no importa: la respuesta va por fecha de examen.`,
  })
  @Transform(toIdList)
  @IsArray({ message: COUNT_MESSAGE })
  @ArrayMinSize(PERIO_COMPARE_MIN, { message: COUNT_MESSAGE })
  @ArrayMaxSize(PERIO_COMPARE_MAX, { message: COUNT_MESSAGE })
  @IsUUID('all', {
    each: true,
    message: 'Cada examen a comparar debe ser un identificador válido',
  })
  examIds!: string[];
}
