import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  MAX_RANGES_PER_DAY,
  MINUTE_STEP,
} from '../../domain/provider-availability';
import { MAX_ROSTER_DAYS } from '../../application/use-cases/provider-schedule.use-cases';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CIVIL_DATE_MESSAGE = 'La fecha tiene que tener el formato AAAA-MM-DD';
const MINUTES_DESCRIPTION = `Minutos de pared desde las 00:00 en la zona de la sede (0–1440), múltiplos de ${MINUTE_STEP}.`;

// ---------------------------------------------------------------------------
// Tramos
// ---------------------------------------------------------------------------

export class MinuteRangeDto {
  @ApiProperty({
    minimum: 0,
    maximum: 1435,
    example: 480,
    description: MINUTES_DESCRIPTION,
  })
  @IsInt()
  @Min(0)
  @Max(1440)
  startMinute!: number;

  @ApiProperty({
    minimum: 5,
    maximum: 1440,
    example: 780,
    description: `${MINUTES_DESCRIPTION} Mayor que el inicio; 1440 = 24:00 (un tramo no cruza medianoche).`,
  })
  @IsInt()
  @Min(0)
  @Max(1440)
  endMinute!: number;
}

export class WeeklyRangeDto extends MinuteRangeDto {
  @ApiProperty({ minimum: 0, maximum: 6, description: '0=domingo .. 6=sábado' })
  @IsInt()
  @Min(0)
  @Max(6)
  weekday!: number;
}

// ---------------------------------------------------------------------------
// Horario semanal
// ---------------------------------------------------------------------------

export class ProviderLocationScheduleInputDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  locationId!: string;

  @ApiProperty({
    type: [WeeklyRangeDto],
    description: `Tramos de la semana en esta sede; como mucho ${MAX_RANGES_PER_DAY} por día. Vacío = no trabaja en esta sede (no se guarda).`,
  })
  @IsArray()
  @ArrayMaxSize(7 * MAX_RANGES_PER_DAY)
  @ValidateNested({ each: true })
  @Type(() => WeeklyRangeDto)
  ranges!: WeeklyRangeDto[];
}

export class ReplaceProviderScheduleDto {
  @ApiProperty({
    type: [ProviderLocationScheduleInputDto],
    description:
      'El horario COMPLETO del profesional, todas sus sedes. Las sedes que no vengan (o vengan sin tramos) dejan de tener horario suyo. Lista vacía = sin horario: se le puede citar en cualquier horario de la sede.',
  })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ProviderLocationScheduleInputDto)
  locations!: ProviderLocationScheduleInputDto[];
}

export class ProviderLocationScheduleDto {
  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({ example: 'Sede Norte' })
  locationName!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'America/Bogota',
    description:
      'Zona IANA de la sede; null si la sede aún no tiene zona configurada (fase 1) o ya no existe.',
  })
  timeZone!: string | null;

  @ApiProperty({ type: [WeeklyRangeDto] })
  ranges!: WeeklyRangeDto[];
}

export class ProviderScheduleDto {
  @ApiProperty({ format: 'uuid' })
  providerId!: string;

  @ApiProperty({
    description:
      'false = sin horario configurado: se le puede citar en cualquier horario de la sede (sin restricción).',
  })
  configured!: boolean;

  @ApiProperty({ type: [ProviderLocationScheduleDto] })
  locations!: ProviderLocationScheduleDto[];
}

// ---------------------------------------------------------------------------
// Excepciones
// ---------------------------------------------------------------------------

export class ListOverridesQueryDto {
  @ApiPropertyOptional({
    example: '2026-10-20',
    description: 'Primer día, incluido. Por defecto, ayer (UTC).',
  })
  @IsOptional()
  @Matches(CIVIL_DATE, { message: CIVIL_DATE_MESSAGE })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-12-31',
    description:
      'Último día, incluido. Por defecto, dos años después de `from`. Como mucho dos años.',
  })
  @IsOptional()
  @Matches(CIVIL_DATE, { message: CIVIL_DATE_MESSAGE })
  to?: string;
}

export class SetProviderOverrideDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  locationId!: string;

  @ApiProperty({
    example: '2026-10-22',
    description:
      'Fecha civil en la zona de la sede: de hoy a dos años vista. Una excepción viva por profesional, sede y fecha: si ya hay una, se reemplaza.',
  })
  @Matches(CIVIL_DATE, { message: CIVIL_DATE_MESSAGE })
  date!: string;

  @ApiProperty({
    type: [MinuteRangeDto],
    description: `Tramos de ese día en esa sede (prevalecen sobre el semanal); como mucho ${MAX_RANGES_PER_DAY}. Vacío = «no trabaja» ese día en esa sede.`,
  })
  @IsArray()
  @ArrayMaxSize(MAX_RANGES_PER_DAY)
  @ValidateNested({ each: true })
  @Type(() => MinuteRangeDto)
  ranges!: MinuteRangeDto[];

  @ApiPropertyOptional({
    maxLength: 200,
    nullable: true,
    example: 'Cubre a la Dra. Ruiz',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string | null;
}

export class ProviderOverrideDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  providerId!: string;

  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({ example: 'Sede Norte' })
  locationName!: string;

  @ApiProperty({ example: '2026-10-22' })
  date!: string;

  @ApiProperty({ type: [MinuteRangeDto] })
  ranges!: MinuteRangeDto[];

  @ApiProperty({ description: 'true = «no trabaja» ese día en esa sede.' })
  off!: boolean;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;
}

export class SetProviderOverrideResultDto extends ProviderOverrideDto {
  @ApiProperty({
    description: 'Había otra excepción para esa sede y fecha y se reemplazó.',
  })
  replaced!: boolean;
}

// ---------------------------------------------------------------------------
// Cuadrante
// ---------------------------------------------------------------------------

export class RosterQueryDto {
  @ApiProperty({
    example: '2026-10-19',
    description:
      'Primer día del cuadrante (normalmente el lunes de la semana).',
  })
  @Matches(CIVIL_DATE, { message: CIVIL_DATE_MESSAGE })
  weekStart!: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_ROSTER_DAYS,
    default: 7,
    description:
      'Días desde `weekStart` (1 = solo ese día, para la vista Día de la agenda).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ROSTER_DAYS)
  days?: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Sede de la agenda: añade a cada día `worksAtLocation` y `locationRanges`.',
  })
  @IsOptional()
  @IsUUID()
  locationId?: string;
}

export class RosterAssignmentDto {
  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({ enum: ['WEEKLY', 'OVERRIDE'] })
  source!: 'WEEKLY' | 'OVERRIDE';

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  overrideId!: string | null;

  @ApiProperty({
    type: [MinuteRangeDto],
    description: 'Vacío = excepción «no trabaja» en esa sede ese día.',
  })
  ranges!: MinuteRangeDto[];
}

export class RosterDayDto {
  @ApiProperty({ example: '2026-10-22' })
  date!: string;

  @ApiProperty({ minimum: 0, maximum: 6 })
  weekday!: number;

  @ApiProperty({
    description:
      'Sin horario configurado y sin excepción ese día: se le puede citar en cualquier sede (no sombrear).',
  })
  unrestricted!: boolean;

  @ApiProperty({
    type: [RosterAssignmentDto],
    description: 'Sedes en las que tiene algo ese día (semanal o excepción).',
  })
  assignments!: RosterAssignmentDto[];

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description:
      'Con `locationId`: trabaja ese día en esa sede (o no tiene restricción). Sin `locationId`, null.',
  })
  worksAtLocation!: boolean | null;

  @ApiProperty({
    type: [MinuteRangeDto],
    nullable: true,
    description:
      'Con `locationId`: sus tramos allí ese día (vacío = no trabaja allí). null = sin restricción o sin `locationId`. La agenda sombrea el resto del día.',
  })
  locationRanges!: MinuteRangeDto[] | null;
}

export class RosterProviderDto {
  @ApiProperty({ format: 'uuid' })
  providerId!: string;

  @ApiProperty({ example: 'Dra. Ximena Ortiz' })
  fullName!: string;

  @ApiProperty({ enum: ClinicRole, enumName: 'ClinicRole' })
  role!: ClinicRole;

  @ApiProperty()
  configured!: boolean;

  @ApiProperty({ type: [RosterDayDto] })
  days!: RosterDayDto[];
}

export class RosterLocationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sede Norte' })
  name!: string;

  @ApiProperty({ example: 'America/Bogota' })
  timeZone!: string;
}

export class RosterDto {
  @ApiProperty({ example: '2026-10-19' })
  from!: string;

  @ApiProperty({ example: '2026-10-25' })
  to!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;

  @ApiProperty({ type: [RosterLocationDto] })
  locations!: RosterLocationDto[];

  @ApiProperty({
    type: [RosterProviderDto],
    description: 'Miembros activos que atienden (DENTIST y ADMIN), por nombre.',
  })
  providers!: RosterProviderDto[];
}

// ---------------------------------------------------------------------------
// Ajuste de la clínica
// ---------------------------------------------------------------------------

export class ProviderScheduleSettingsDto {
  @ApiProperty({
    description:
      'false (defecto): una cita fuera del horario del profesional se agenda con el aviso PROVIDER_OFF_SCHEDULE. true: se rechaza con 409.',
  })
  @IsBoolean()
  strictProviderSchedule!: boolean;
}
