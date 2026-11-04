import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ChairSummaryDto } from '../../../chairs/presentation/dto/chair.dto';
import { MAX_CHAIR_COLUMNS } from '../../../chairs/domain/chair-rules';
import { MAX_OPENINGS, MAX_OPENINGS_RANGE_DAYS } from '../../domain/openings';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CIVIL_DATE_MESSAGE = 'La fecha tiene que tener el formato AAAA-MM-DD';

// `?chairIds=a` llega como texto; repetido, como lista.
function toArray({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? [value] : value;
}

export class OpeningsQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  providerId!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Sede: su horario, su zona horaria y sus bloqueos.',
  })
  @IsUUID()
  locationId!: string;

  @ApiProperty({
    example: '2026-10-20',
    description: 'Primer día (zona de la sede), incluido.',
  })
  @Matches(CIVIL_DATE, { message: CIVIL_DATE_MESSAGE })
  from!: string;

  @ApiProperty({
    example: '2026-10-31',
    description: `Último día, incluido. Como mucho ${MAX_OPENINGS_RANGE_DAYS} días desde \`from\`.`,
  })
  @Matches(CIVIL_DATE, { message: CIVIL_DATE_MESSAGE })
  to!: string;

  @ApiProperty({ minimum: 5, maximum: 480, example: 30 })
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(480)
  durationMinutes!: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Paciente: sus otras citas también ocupan.',
  })
  @IsOptional()
  @IsUUID()
  patientId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'DX-509-bis: la cita que se va a mover no ocupa (si no, su propia hora taparía los huecos de al lado). 404 si no es de esta clínica.',
  })
  @IsOptional()
  @IsUUID()
  excludeAppointmentId?: string;

  @ApiPropertyOptional({
    type: String,
    isArray: true,
    format: 'uuid',
    maxItems: MAX_CHAIR_COLUMNS,
    description: `DX-492: sillones activos de la sede. Solo salen los huecos en los que también está libre alguno de ellos, y cada hueco dice cuál (\`chair\`). Uno de otra sede o desactivado da 400; de otra clínica, 404. Hasta ${MAX_CHAIR_COLUMNS}; se repite el parámetro: ?chairIds=a&chairIds=b.`,
  })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_CHAIR_COLUMNS, {
    message: `Puedes buscar en como mucho ${MAX_CHAIR_COLUMNS} sillones a la vez`,
  })
  @IsUUID('all', { each: true })
  chairIds?: string[];
}

export class OpeningDto {
  @ApiProperty({
    format: 'date-time',
    description: 'Inicio del hueco (múltiplo de 5 min, nunca en el pasado).',
  })
  start!: Date;

  @ApiProperty({
    format: 'date-time',
    description: 'Fin del hueco (cabe al menos la duración pedida).',
  })
  end!: Date;

  @ApiPropertyOptional({
    type: () => ChairSummaryDto,
    description:
      'DX-492: el sillón libre en todo el hueco. Solo si se pidió `chairIds`.',
  })
  chair?: ChairSummaryDto;
}

export class OpeningsDto {
  @ApiProperty({ example: 'UTC' })
  timeZone!: string;

  @ApiProperty()
  durationMinutes!: number;

  @ApiProperty({ type: [OpeningDto] })
  openings!: OpeningDto[];

  @ApiProperty({
    description: `Había más de ${MAX_OPENINGS} huecos: acota el rango.`,
  })
  truncated!: boolean;

  @ApiProperty({
    description:
      'DX-533: la sede no tiene horario configurado y los huecos se buscaron en el horario de alta (lun–vie 9:00–13:00 y 15:00–19:00, sáb 9:00–13:00, hora de la sede). Reservar fuera de él sigue permitido.',
  })
  defaultHours!: boolean;
}
