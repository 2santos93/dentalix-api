import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import { MAX_OPENINGS, MAX_OPENINGS_RANGE_DAYS } from '../../domain/openings';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CIVIL_DATE_MESSAGE = 'La fecha tiene que tener el formato AAAA-MM-DD';

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
      'DX-509-bis: la cita que se va a mover no ocupa (si no, su propia hora taparía los huecos de al lado). Una cita que no existe no cambia nada.',
  })
  @IsOptional()
  @IsUUID()
  excludeAppointmentId?: string;
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
}
