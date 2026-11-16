import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AppointmentStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import {
  PERIOD_DAY_MAX,
  PERIOD_DAY_MIN,
} from '../../../../shared/time/civil-day';
import {
  FORECAST_FORMULA,
  SCHEDULED_PRODUCTION_DEFINITION_KEYS,
  SCHEDULED_PRODUCTION_WARNINGS,
  type ScheduledProductionDefinitionKey,
  type ScheduledProductionWarning,
} from '../../domain/scheduled-production';
import {
  SCHEDULED_PRODUCTION_MAX_DAYS,
  SCHEDULED_PRODUCTION_PAGE_SIZE,
} from '../../application/use-cases/get-scheduled-production.use-case';

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAGE = 100000;
const MAX_PAGE_SIZE = 100;

// Filtros de GET /reports/scheduled-production y su lista (DX-567).
export class ScheduledProductionQueryDto {
  @ApiProperty({
    example: '2026-11-01',
    description: `Primer día del período (AAAA-MM-DD): cuenta el día de inicio de cada cita en la zona horaria de su sede. Como mucho ${SCHEDULED_PRODUCTION_MAX_DAYS} días; las dos fechas entre ${PERIOD_DAY_MIN} y ${PERIOD_DAY_MAX} (400 si no). No cambia la previsión, que es siempre del mes en curso.`,
  })
  @Matches(CIVIL_DATE, { message: 'from debe ser una fecha AAAA-MM-DD.' })
  from!: string;

  @ApiProperty({
    example: '2026-11-30',
    description: 'Último día del período (inclusive)',
  })
  @Matches(CIVIL_DATE, { message: 'to debe ser una fecha AAAA-MM-DD.' })
  to!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo las citas (y, en la previsión, lo realizado) de esta sede (403 si no es de las del usuario o no es de la clínica: la misma respuesta, sin decir qué sedes existen). Sin él, todas las sedes que ve. La cabecera X-Location-Id no acota.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser un UUID.' })
  locationId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo las citas de este profesional (y, en la previsión, lo que realizó). Quien ve solo lo suyo (scope OWN) solo puede pedirse a sí mismo (403 si no); sin él, ve igualmente solo lo suyo.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'providerId debe ser un UUID.' })
  providerId?: string;
}

export class ScheduledProductionUnlinkedQueryDto extends ScheduledProductionQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un número entero.' })
  @Min(1, { message: 'page empieza en 1.' })
  @Max(MAX_PAGE, { message: `page admite hasta ${MAX_PAGE}.` })
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: SCHEDULED_PRODUCTION_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize debe ser un número entero.' })
  @Min(1, { message: 'pageSize debe ser al menos 1.' })
  @Max(MAX_PAGE_SIZE, { message: `pageSize admite hasta ${MAX_PAGE_SIZE}.` })
  pageSize?: number;
}

export class ScheduledProductionPeriodDto {
  @ApiProperty({ example: '2026-11-01' })
  from!: string;

  @ApiProperty({ example: '2026-11-30' })
  to!: string;
}

export class ScheduledProductionFiltersDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Con scope OWN, siempre quien consulta',
  })
  providerId!: string | null;
}

export class ScheduledProductionTotalsDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 1250,
    description:
      'Agendado del período en la moneda del catálogo (2 decimales). null = sin moneda de catálogo',
  })
  scheduledAmount!: number | null;

  @ApiProperty({
    description: 'Citas que cuentan (ni canceladas ni inasistencias)',
  })
  appointments!: number;

  @ApiProperty({
    description: 'De esas citas, las que no tienen tratamiento ligado',
  })
  appointmentsWithoutItems!: number;
}

export class ScheduledProductionDayDto extends ScheduledProductionTotalsDto {
  @ApiProperty({
    example: '2026-11-17',
    description: 'Día civil (AAAA-MM-DD) en la zona de la sede de cada cita',
  })
  date!: string;
}

export class ScheduledProductionProfessionalDto extends ScheduledProductionTotalsDto {
  @ApiProperty({
    format: 'uuid',
    description: 'El profesional de la cita (`providerId`)',
  })
  professionalId!: string;

  @ApiProperty({ example: 'Dra. Andrea Pérez' })
  name!: string;
}

export class ScheduledProductionDayProfessionalDto {
  @ApiProperty({ example: '2026-11-17' })
  date!: string;

  @ApiProperty({ format: 'uuid' })
  professionalId!: string;

  @ApiProperty({ type: Number, nullable: true, example: 100 })
  scheduledAmount!: number | null;

  @ApiProperty()
  appointments!: number;
}

export class ScheduledProductionForecastDto {
  @ApiProperty({
    example: '2026-11',
    description:
      'Mes en curso (AAAA-MM) de la sede de referencia: la elegida o, si no, la principal. Cada sede usa su propio mes y su hoy (aviso MIXED_MONTHS si no coinciden).',
  })
  month!: string;

  @ApiProperty({
    example: '2026-11-17',
    description: 'Hoy (AAAA-MM-DD) en la sede de referencia',
  })
  today!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 3200,
    description:
      'Producido hasta hoy: realizados desde el día 1 del mes hasta hoy (incluido), en la moneda del catálogo. null = sin moneda de catálogo',
  })
  producedToDate!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 1800,
    description:
      'Agendado pendiente: aceptados aún no realizados en citas de hoy a fin de mes. null = sin moneda de catálogo',
  })
  scheduledPending!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 5000,
    description: `${FORECAST_FORMULA} (suma de los dos ya redondeados). null = sin moneda de catálogo`,
  })
  forecast!: number | null;

  @ApiProperty({
    description:
      'Procedimientos de la previsión (realizados o pendientes) fuera de los importes por falta de tasa guardada',
  })
  itemsWithoutRate!: number;
}

export class ScheduledProductionWithoutRateDto {
  @ApiProperty({
    description:
      'Citas del período con algún procedimiento en otra moneda sin tasa guardada del día: cuentan en las citas y quedan fuera de los importes',
  })
  appointments!: number;

  @ApiProperty({
    description: 'Procedimientos del período fuera de los importes por eso',
  })
  items!: number;
}

export class ScheduledProductionDefinitionDto {
  @ApiProperty({ enum: SCHEDULED_PRODUCTION_DEFINITION_KEYS })
  key!: ScheduledProductionDefinitionKey;

  @ApiProperty({ example: 'Agendado' })
  label!: string;

  @ApiProperty({
    type: [String],
    description: '«Cómo se calcula», una regla por línea',
  })
  howItIsCalculated!: string[];
}

export class ScheduledProductionLocationOptionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Sede Chacao' })
  name!: string;

  @ApiProperty({ description: 'false = sede desactivada (sigue saliendo)' })
  isActive!: boolean;
}

export class ScheduledProductionProfessionalOptionDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ example: 'Dra. Andrea Pérez' })
  fullName!: string;
}

export class ScheduledProductionOptionsDto {
  @ApiProperty({
    type: [ScheduledProductionLocationOptionDto],
    description: 'Las sedes que ve quien consulta (DX-089)',
  })
  locations!: ScheduledProductionLocationOptionDto[];

  @ApiProperty({
    type: [ScheduledProductionProfessionalOptionDto],
    description:
      'Miembros que atienden alguna cita en esas sedes; con scope OWN, solo quien consulta',
  })
  professionals!: ScheduledProductionProfessionalOptionDto[];
}

export class ScheduledProductionReportDto {
  @ApiProperty({ type: ScheduledProductionPeriodDto })
  period!: ScheduledProductionPeriodDto;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Moneda del catálogo de la clínica: la de todos los importes. null = no se resuelve (aviso NO_CATALOG_CURRENCY; importes null, los recuentos siguen)',
  })
  currency!: string | null;

  @ApiProperty({
    enum: ['CLINIC', 'OWN'],
    description:
      'CLINIC: toda la clínica (ADMIN o FINANCIAL_REPORTS_VIEW); OWN: solo lo de quien consulta (DENTIST)',
  })
  scope!: 'CLINIC' | 'OWN';

  @ApiProperty({
    description:
      'true = quien consulta solo ve algunas sedes (DX-089): las cifras son de esas',
  })
  restrictedToLocations!: boolean;

  @ApiProperty({ type: ScheduledProductionFiltersDto })
  filters!: ScheduledProductionFiltersDto;

  @ApiProperty({ type: ScheduledProductionTotalsDto })
  totals!: ScheduledProductionTotalsDto;

  @ApiProperty({
    type: [ScheduledProductionDayDto],
    description: 'TODOS los días del período, en orden (también con 0)',
  })
  byDay!: ScheduledProductionDayDto[];

  @ApiProperty({
    type: [ScheduledProductionProfessionalDto],
    description:
      'Una fila por profesional con citas en el período (por importe desc, luego nombre); con scope OWN, solo la suya',
  })
  byProfessional!: ScheduledProductionProfessionalDto[];

  @ApiProperty({
    type: [ScheduledProductionDayProfessionalDto],
    description:
      'Por día y profesional (solo los pares con citas), por día y nombre: la tira de la agenda',
  })
  byDayAndProfessional!: ScheduledProductionDayProfessionalDto[];

  @ApiProperty({
    type: ScheduledProductionForecastDto,
    description:
      'Previsión del mes en curso con los mismos filtros de sede y profesional (no depende de from/to)',
  })
  forecast!: ScheduledProductionForecastDto;

  @ApiProperty({ type: ScheduledProductionWithoutRateDto })
  withoutRate!: ScheduledProductionWithoutRateDto;

  @ApiProperty({
    description:
      'Realizados sin sede o sin fecha (anteriores a DX-050): no entran en lo producido (aviso UNATTRIBUTED_DONE)',
  })
  unattributedDone!: number;

  @ApiProperty({
    enum: SCHEDULED_PRODUCTION_WARNINGS,
    isArray: true,
    description:
      'NO_CATALOG_CURRENCY: sin moneda de catálogo (importes null). WITHOUT_RATE: hay importes fuera por falta de tasa guardada (ver withoutRate y forecast.itemsWithoutRate). MIXED_MONTHS: alguna sede está en otro mes que la de referencia. UNATTRIBUTED_DONE: hay realizados sin sede o sin fecha',
  })
  warnings!: ScheduledProductionWarning[];

  @ApiProperty({
    type: [ScheduledProductionDefinitionDto],
    description:
      'Agendado, sin tratamiento, producido hasta hoy, agendado pendiente, previsión (con la fórmula) y sin tasa («Cómo se calcula»)',
  })
  definitions!: ScheduledProductionDefinitionDto[];

  @ApiProperty({ type: ScheduledProductionOptionsDto })
  options!: ScheduledProductionOptionsDto;
}

export class UnlinkedAppointmentDto {
  @ApiProperty({ format: 'uuid' })
  appointmentId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  start!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  end!: Date;

  @ApiProperty({
    enum: AppointmentStatus,
    enumName: 'AppointmentStatus',
    description: 'Nunca CANCELLED ni NO_SHOW (no cuentan)',
  })
  status!: AppointmentStatus;

  @ApiProperty({
    format: 'uuid',
    description:
      'Paciente vivo o archivado (las citas de un paciente eliminado no cuentan)',
  })
  patientId!: string;

  @ApiProperty({ example: 'María Fernández' })
  patientName!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Control' })
  appointmentTypeName!: string | null;

  @ApiProperty({ format: 'uuid' })
  professionalId!: string;

  @ApiProperty({ type: String, nullable: true })
  professionalName!: string | null;

  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({ example: 'Sede Chacao' })
  locationName!: string;

  @ApiProperty({
    example: 'America/Caracas',
    description: 'Zona de la sede: la hora se pinta con ella',
  })
  timeZone!: string;
}

export class ScheduledProductionUnlinkedDto {
  @ApiProperty({
    type: [UnlinkedAppointmentDto],
    description: 'Por inicio de la cita (asc)',
  })
  items!: UnlinkedAppointmentDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}
