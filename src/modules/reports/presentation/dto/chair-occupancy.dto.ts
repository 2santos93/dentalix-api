import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';
import {
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
} from '../../../../shared/time/civil-day';
import { CHAIR_OCCUPANCY_MAX_DAYS } from '../../application/use-cases/get-chair-occupancy.use-case';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Filtros de GET /reports/chair-occupancy y de su CSV (DX-481).
export class ChairOccupancyQueryDto {
  @ApiProperty({
    example: '2026-10-01',
    description: `Primer día del período (AAAA-MM-DD, en la zona de cada sede). Como mucho ${CHAIR_OCCUPANCY_MAX_DAYS} días; las dos fechas entre ${PERIOD_DAY_MIN} y ${PERIOD_DAY_MAX} (400 si no).`,
  })
  @Matches(CIVIL_DATE, { message: 'from debe ser una fecha AAAA-MM-DD.' })
  from!: string;

  @ApiProperty({ example: '2026-10-31', description: 'Último día (inclusive)' })
  @Matches(CIVIL_DATE, { message: 'to debe ser una fecha AAAA-MM-DD.' })
  to!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo esta sede (403 si no es de las del usuario o no es de la clínica: la misma respuesta, sin decir qué sedes existen). Sin él, todas las sedes que ve. La cabecera X-Location-Id no acota.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;
}

export class ChairOccupancyMetricsDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 1320,
    description:
      'Minutos abiertos: horario semanal de la sede en el período − cierres de toda la sede − festivos. En el total de la sede, abiertos por sillón × sillones. null = la sede no tiene horario («Sin horario») o es la fila «Sin sillón».',
  })
  openMinutes!: number | null;

  @ApiProperty({
    example: 990,
    description:
      'Minutos de citas no canceladas (inasistencias incluidas), recortados al período y, con horario, a sus tramos abiertos. En un sillón, las citas que se pisan cuentan una vez; en «Sin sillón», cada una suma.',
  })
  reservedMinutes!: number;

  @ApiProperty({
    example: 840,
    description: 'Lo mismo, solo de las citas atendidas (COMPLETED)',
  })
  attendedMinutes!: number;

  @ApiProperty({
    example: 60,
    description:
      'Lo mismo, solo de las inasistencias (NO_SHOW): reservadas y no atendidas',
  })
  noShowMinutes!: number;

  @ApiProperty({
    description: 'Citas no canceladas que tocan el período',
  })
  reservedAppointments!: number;

  @ApiProperty({ description: 'De ellas, atendidas (COMPLETED)' })
  attendedAppointments!: number;

  @ApiProperty({ description: 'De ellas, inasistencias (NO_SHOW)' })
  noShowAppointments!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 0.75,
    description:
      'Ocupación = reservados ÷ abiertos, de 0 a 1 (tope 1); null sin abiertos',
  })
  reservedRate!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 0.6364,
    description: 'Atendidos ÷ abiertos, de 0 a 1 (tope 1); null sin abiertos',
  })
  attendedRate!: number | null;
}

export class ChairOccupancyRowDto extends ChairOccupancyMetricsDto {
  @ApiProperty({ format: 'uuid' })
  chairId!: string;

  @ApiProperty({ example: 'Sillón 1' })
  chairName!: string;

  @ApiProperty({
    description:
      'false = sillón desactivado: solo sale si tuvo citas no canceladas en el período',
  })
  active!: boolean;
}

export class LocationChairOccupancyDto {
  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({ example: 'Sede Chacao' })
  locationName!: string;

  @ApiProperty({ example: 'America/Caracas' })
  timeZone!: string;

  @ApiProperty({
    description:
      'La sede tiene horario semanal con tramos. Sin él (en la agenda, «sin restricción») no hay abiertos ni porcentajes.',
  })
  hasSchedule!: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Minutos abiertos de UN sillón (los de la sede); null sin horario',
  })
  openMinutesPerChair!: number | null;

  @ApiProperty({ description: 'Días del período cerrados por festivo' })
  holidayDays!: number;

  @ApiProperty({
    type: [ChairOccupancyRowDto],
    description:
      'Sillones activos y los desactivados con citas, por orden de la agenda y nombre',
  })
  chairs!: ChairOccupancyRowDto[];

  @ApiProperty({
    type: ChairOccupancyMetricsDto,
    nullable: true,
    description:
      '«Sin sillón»: citas de la sede sin sillón asignado (sin %). null si no hay.',
  })
  noChair!: ChairOccupancyMetricsDto | null;

  @ApiProperty({
    type: ChairOccupancyMetricsDto,
    description:
      'Total de la sede: suma de sus sillones (sin «Sin sillón»), sobre abiertos × sillones',
  })
  totals!: ChairOccupancyMetricsDto;
}

export class ChairOccupancyReportDto {
  @ApiProperty({ example: '2026-10-01' })
  from!: string;

  @ApiProperty({ example: '2026-10-31' })
  to!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;

  @ApiProperty({
    description: 'El usuario solo ve algunas sedes (DX-089)',
  })
  restrictedToLocations!: boolean;

  @ApiProperty({
    type: [LocationChairOccupancyDto],
    description:
      'Una entrada por sede visible (con zona horaria), por fecha de alta',
  })
  locations!: LocationChairOccupancyDto[];
}
