import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';
import {
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
} from '../../../../shared/time/civil-day';
import {
  ProductionLocationOptionDto,
  ProductionProfessionalOptionDto,
} from './production-by-procedure.dto';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Filtros de GET /reports/timing y /reports/timing.csv (DX-275).
export class TimingQueryDto {
  @ApiProperty({
    example: '2026-01-01',
    description: `Primer día del período (AAAA-MM-DD, días civiles en la zona de cada sede). Como mucho 12 meses por calendario; las dos fechas entre ${PERIOD_DAY_MIN} y ${PERIOD_DAY_MAX} (400 si no).`,
  })
  @Matches(CIVIL_DATE, { message: 'from debe ser una fecha AAAA-MM-DD.' })
  from!: string;

  @ApiProperty({ example: '2026-06-30', description: 'Último día (inclusive)' })
  @Matches(CIVIL_DATE, { message: 'to debe ser una fecha AAAA-MM-DD.' })
  to!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo las citas y el horario de esta sede. 404 si no es una sede viva de la clínica; 403 si es de la clínica pero no de las del usuario (DX-089). Sin él, todas las que ve. La cabecera X-Location-Id no acota.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo las citas y el horario de este profesional. ADMIN: cualquiera (uno que no atiende en la clínica da un informe vacío). DENTIST: siempre él mismo; pedir a otro es 403.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'providerId debe ser un UUID.' })
  providerId?: string;
}

export class TimingFiltersDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  locationName!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'El profesional pedido; con un DENTIST, siempre él mismo',
  })
  providerId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  providerName!: string | null;
}

export class TimingOptionsDto {
  @ApiProperty({
    type: [ProductionLocationOptionDto],
    description: 'Las sedes que ve quien consulta (DX-089)',
  })
  locations!: ProductionLocationOptionDto[];

  @ApiProperty({
    type: [ProductionProfessionalOptionDto],
    description:
      'Quien tiene citas u horario en esas sedes (también ex-miembros), por nombre. A un DENTIST, solo él mismo.',
  })
  professionals!: ProductionProfessionalOptionDto[];
}

const MINUTES = (what: string) => ({
  type: Number,
  nullable: true,
  description: `${what}, en minutos con 1 decimal; null sin citas con tiempos válidos`,
});

export class TimingFiguresDto {
  @ApiProperty({ description: 'Citas atendidas (completadas) del período' })
  completed!: number;

  @ApiProperty({
    description:
      'Con tiempos válidos: las únicas que entran en medias y p90 (= completed − withoutTimes − incoherent)',
  })
  measured!: number;

  @ApiProperty({
    description:
      'Atendidas sin hora de llegada, de sillón o de listo para cobrar («X citas sin tiempos»)',
  })
  withoutTimes!: number;

  @ApiProperty({
    description:
      'Con las tres horas pero fuera de los umbrales de `thresholds` (excluidas)',
  })
  incoherent!: number;

  @ApiProperty(MINUTES('Espera en sala media'))
  waitAvgMinutes!: number | null;

  @ApiProperty(MINUTES('Espera en sala p90'))
  waitP90Minutes!: number | null;

  @ApiProperty(
    MINUTES('Retraso de inicio medio (negativo = se empezó antes de la hora)'),
  )
  startDelayAvgMinutes!: number | null;

  @ApiProperty(MINUTES('Retraso de inicio p90'))
  startDelayP90Minutes!: number | null;

  @ApiProperty(MINUTES('Duración real media (sillón → listo para cobrar)'))
  durationAvgMinutes!: number | null;

  @ApiProperty(MINUTES('Duración real p90'))
  durationP90Minutes!: number | null;

  @ApiProperty(MINUTES('Duración programada media (fin − inicio agendados)'))
  plannedAvgMinutes!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      '(real media − programada media) ÷ programada media × 100, 1 decimal; positivo = duran más de lo agendado',
  })
  durationVsPlannedPercent!: number | null;
}

export class TimingProfessionalRowDto extends TimingFiguresDto {
  @ApiProperty({ format: 'uuid' })
  providerId!: string;

  @ApiProperty({ description: '«Profesional sin nombre» si falta' })
  providerName!: string;
}

export class TimingTypeRowDto extends TimingFiguresDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'null = las citas sin tipo (fila «Sin tipo de cita», al final)',
  })
  appointmentTypeId!: string | null;

  @ApiProperty()
  appointmentTypeName!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Duración del tipo en el catálogo hoy (DX-121); null sin tipo. Referencia para ajustarla.',
  })
  catalogDurationMinutes!: number | null;

  @ApiProperty({
    description:
      'Aviso «se excede»: ≥ `thresholds.overrunMinAppointments` citas medidas y real frente a programada > `thresholds.overrunPercent` %. Nunca en «Sin tipo».',
  })
  exceedsPlanned!: boolean;
}

export class TimingWeekRowDto extends TimingFiguresDto {
  @ApiProperty({
    example: '2026-03-02',
    description: 'Lunes de la semana (zona de cada sede)',
  })
  weekStart!: string;

  @ApiProperty({
    example: '2026-03-02',
    description: 'Primer día de la semana dentro del período',
  })
  from!: string;

  @ApiProperty({
    example: '2026-03-08',
    description: 'Último día de la semana dentro del período',
  })
  to!: string;
}

export class TimingOccupancyFiguresDto {
  @ApiProperty({
    description:
      'Minutos del horario (DX-233) − festivos de la sede − bloqueos que no admiten citas (DX-122) − cierres de la sede',
  })
  availableMinutes!: number;

  @ApiProperty({
    description: 'Minutos programados de las citas vivas no canceladas',
  })
  bookedMinutes!: number;

  @ApiProperty({ description: 'Minutos programados de las completadas' })
  attendedMinutes!: number;

  @ApiProperty({ description: 'Minutos programados de las «No asistió»' })
  noShowMinutes!: number;

  @ApiProperty({
    description:
      'máx(0, disponibles − citadas) de cada semana, sumado (lo citado de más una semana no libera otra)',
  })
  freeMinutes!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'atendidas ÷ disponibles × 100, 1 decimal; null sin horario («Sin horario»). Puede pasar de 100.',
  })
  occupancyPercent!: number | null;
}

export class TimingOccupancyWeekDto extends TimingOccupancyFiguresDto {
  @ApiProperty({ example: '2026-03-02' })
  weekStart!: string;

  @ApiProperty({ example: '2026-03-02' })
  from!: string;

  @ApiProperty({ example: '2026-03-08' })
  to!: string;
}

export class TimingOccupancyRowDto extends TimingOccupancyFiguresDto {
  @ApiProperty({ format: 'uuid' })
  providerId!: string;

  @ApiProperty()
  providerName!: string;

  @ApiProperty({
    description:
      'Tiene horario con días en alguna sede del informe; false = «Sin horario»',
  })
  hasSchedule!: boolean;

  @ApiProperty({
    type: [TimingOccupancyWeekDto],
    description: 'Todas las semanas del período, en orden',
  })
  weeks!: TimingOccupancyWeekDto[];
}

export class TimingOccupancyDto {
  @ApiProperty({
    type: [TimingOccupancyRowDto],
    description:
      'Un profesional con horario en las sedes del informe o con citas en el período, por nombre',
  })
  professionals!: TimingOccupancyRowDto[];

  @ApiProperty({ type: TimingOccupancyFiguresDto })
  totals!: TimingOccupancyFiguresDto;
}

export class TimingThresholdsDto {
  @ApiProperty({ example: 240 })
  maxWaitMinutes!: number;

  @ApiProperty({ example: 720 })
  maxStartGapMinutes!: number;

  @ApiProperty({ example: 1 })
  minDurationMinutes!: number;

  @ApiProperty({ example: 480 })
  maxDurationMinutes!: number;

  @ApiProperty({ example: 20 })
  overrunPercent!: number;

  @ApiProperty({ example: 10 })
  overrunMinAppointments!: number;
}

export class TimingDefinitionDto {
  @ApiProperty({
    enum: [
      'completed',
      'withoutTimes',
      'incoherent',
      'wait',
      'startDelay',
      'duration',
      'planned',
      'durationVsPlanned',
      'typeOverrun',
      'availableMinutes',
      'bookedMinutes',
      'attendedMinutes',
      'noShowMinutes',
      'freeMinutes',
      'occupancy',
    ],
  })
  key!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty({ enum: ['COUNT', 'MINUTES', 'PERCENT'] })
  unit!: 'COUNT' | 'MINUTES' | 'PERCENT';

  @ApiProperty({ description: 'Texto del tooltip «Cómo se calcula»' })
  howItIsCalculated!: string;
}

export class TimingReportDto {
  @ApiProperty({ example: '2026-01-01' })
  from!: string;

  @ApiProperty({ example: '2026-06-30' })
  to!: string;

  @ApiProperty({
    enum: ['CLINIC', 'OWN'],
    description: 'CLINIC: ADMIN, todo el equipo; OWN: un DENTIST, solo lo suyo',
  })
  scope!: 'CLINIC' | 'OWN';

  @ApiProperty({ type: TimingFiltersDto })
  filters!: TimingFiltersDto;

  @ApiProperty({ type: TimingOptionsDto })
  options!: TimingOptionsDto;

  @ApiProperty({ type: TimingFiguresDto })
  totals!: TimingFiguresDto;

  @ApiProperty({
    type: [TimingProfessionalRowDto],
    description: 'Una fila por profesional con citas atendidas, por nombre',
  })
  byProfessional!: TimingProfessionalRowDto[];

  @ApiProperty({
    type: [TimingTypeRowDto],
    description:
      'Una fila por tipo de cita con citas atendidas: primero los que se exceden, luego por nombre; «Sin tipo de cita» al final',
  })
  byAppointmentType!: TimingTypeRowDto[];

  @ApiProperty({
    type: [TimingWeekRowDto],
    description:
      'Todas las semanas (lunes a domingo) que toca el período, en orden, también sin citas',
  })
  byWeek!: TimingWeekRowDto[];

  @ApiProperty({ type: TimingOccupancyDto })
  occupancy!: TimingOccupancyDto;

  @ApiProperty({
    type: TimingThresholdsDto,
    description: 'Umbrales de coherencia y del aviso por tipo',
  })
  thresholds!: TimingThresholdsDto;

  @ApiProperty({
    description:
      'Nota común a todas las cifras (qué citas cuentan, zona horaria, p90)',
  })
  scopeNote!: string;

  @ApiProperty({
    type: [TimingDefinitionDto],
    description: 'Definición fija de cada cifra, para mostrarla tal cual',
  })
  definitions!: TimingDefinitionDto[];

  @ApiProperty({
    description:
      'false = «Sin datos en el período»: ni citas atendidas ni profesionales con horario o citas',
  })
  hasData!: boolean;
}
