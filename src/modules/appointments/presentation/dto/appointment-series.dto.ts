import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
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
import { CancellationReasonCode } from '@prisma/client';
import { CreateAppointmentDto } from './create-appointment.dto';
import { AppointmentDto } from './appointment.dto';
import {
  APPOINTMENT_WARNING_CODES,
  type AppointmentWarningCode,
} from '../../domain/entities/appointment.entity';
import {
  SERIES_DATE_MESSAGES,
  SERIES_MAX_INTERVAL_WEEKS,
  SERIES_MAX_OCCURRENCES,
  SERIES_MIN_INTERVAL_WEEKS,
  SERIES_MIN_OCCURRENCES,
} from '../../domain/series-dates';
import {
  SERIES_NOTIFY_SKIP_REASONS,
  type SeriesNotifySkipReason,
} from '../../application/use-cases/appointment-series.use-case';
import {
  APPOINTMENT_SERIES_CONFLICT_CODE,
  SERIES_CONFLICT_CODES,
  type SeriesConflictCode,
} from '../../application/series-conflicts';
import {
  CANCEL_REASON_TEXT_MAX,
  CANCELLATION_MESSAGES,
  STAFF_CANCELLATION_KINDS,
  type StaffCancellationKind,
} from '../../../cancellation-policies/domain/cancellation-policy';

/**
 * DX-562: la cita base de una serie. Los mismos campos y reglas que agendar
 * una cita suelta (`POST /appointments`), SIN los que no tienen sentido en
 * una serie: ítems del plan (un ítem reserva una sola cita), «Adelantar si hay
 * hueco» y «Agendar igualmente» en un hueco reservado (es un choque más: se
 * omite o se cambia la hora).
 */
export class AppointmentSeriesBaseDto extends OmitType(CreateAppointmentDto, [
  'planItemIds',
  'wantsEarlier',
  'overrideReason',
  // DX-465: el «Agendó» con canal y nota es del alta suelta desde recall.
  'recallContact',
] as const) {
  @ApiProperty({
    minimum: SERIES_MIN_INTERVAL_WEEKS,
    maximum: SERIES_MAX_INTERVAL_WEEKS,
    example: 4,
    description: 'Cada cuántas semanas se repite la cita (1–12).',
  })
  @Type(() => Number)
  @IsInt({ message: SERIES_DATE_MESSAGES.interval })
  @Min(SERIES_MIN_INTERVAL_WEEKS, { message: SERIES_DATE_MESSAGES.interval })
  @Max(SERIES_MAX_INTERVAL_WEEKS, { message: SERIES_DATE_MESSAGES.interval })
  intervalWeeks!: number;
}

export class PreviewAppointmentSeriesDto extends AppointmentSeriesBaseDto {
  @ApiPropertyOptional({
    minimum: SERIES_MIN_OCCURRENCES,
    maximum: SERIES_MAX_OCCURRENCES,
    example: 6,
    description:
      'Cuántas citas en total, la base incluida (2–26). Uno de `count` o `until`.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: SERIES_DATE_MESSAGES.count })
  @Min(SERIES_MIN_OCCURRENCES, { message: SERIES_DATE_MESSAGES.count })
  @Max(SERIES_MAX_OCCURRENCES, { message: SERIES_DATE_MESSAGES.count })
  count?: number;

  @ApiPropertyOptional({
    example: '2027-06-28',
    description:
      'Último día civil (AAAA-MM-DD, en la zona de la sede) que puede tener una cita, incluido; como mucho a un año de la base y sin pasar de 26 citas. Uno de `count` o `until`.',
  })
  @IsOptional()
  @IsString({ message: SERIES_DATE_MESSAGES.untilInvalid })
  @MaxLength(10, { message: SERIES_DATE_MESSAGES.untilInvalid })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: SERIES_DATE_MESSAGES.untilInvalid,
  })
  until?: string;
}

/** Una fecha final de la serie (la propuesta o la hora elegida). */
export class AppointmentSeriesOccurrenceInputDto {
  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  start!: string;
}

/**
 * Crear: la MISMA recurrencia que la vista previa (`count` o `until`) y las
 * fechas finales; el servidor vuelve a generar la propuesta y exige que cada
 * fecha caiga en uno de sus días.
 */
export class CreateAppointmentSeriesDto extends PreviewAppointmentSeriesDto {
  @ApiProperty({
    type: [AppointmentSeriesOccurrenceInputDto],
    minItems: SERIES_MIN_OCCURRENCES,
    maxItems: SERIES_MAX_OCCURRENCES,
    description:
      'Las fechas FINALES de la serie, tras la vista previa: cada una con su inicio (la propuesta, la alternativa elegida u otra hora del MISMO día civil de la sede); las omitidas no se envían. De 2 a 26, una por día de la propuesta (si no, 400: «Cada fecha tiene que caer en uno de los días de la serie…» o «Hay dos fechas para el mismo día de la serie.»). La duración de todas es la de la cita base (`end` − `start`, o la del tipo). La posición guardada en la serie (`series.index`) sale del orden por fecha entre las creadas; el `index` de un 409 es el de la vista previa.',
  })
  @IsArray()
  @ArrayMinSize(SERIES_MIN_OCCURRENCES, { message: SERIES_DATE_MESSAGES.count })
  @ArrayMaxSize(SERIES_MAX_OCCURRENCES, { message: SERIES_DATE_MESSAGES.count })
  @ValidateNested({ each: true })
  @Type(() => AppointmentSeriesOccurrenceInputDto)
  occurrences!: AppointmentSeriesOccurrenceInputDto[];

  @ApiPropertyOptional({
    default: true,
    description:
      'Mandar al paciente UN email con todas las fechas (plantilla `appointment-series`, en su idioma). Va a quien recibe los recordatorios (un menor o sin email: su responsable) y solo si su canal es email, no se dio de baja (DX-128) y cabe en el tope de emails (si no, la serie se crea igual: `notifyReason: QUOTA`). `false` = sin aviso.',
  })
  @IsOptional()
  @IsBoolean()
  notifyPatient?: boolean;
}

/** DX-562 (D5): cancelar «esta y las siguientes». */
export class CancelAppointmentSeriesDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'La cita desde la que se cancela (incluida), de esta serie. Se cancelan ella y las siguientes que siguen agendadas o confirmadas y aún no empezaron.',
  })
  @IsUUID()
  fromAppointmentId!: string;

  @ApiProperty({
    enum: STAFF_CANCELLATION_KINDS,
    description:
      'Quién cancela, como en `PATCH /appointments/:id`: STAFF_FOR_PATIENT (el paciente lo comunica) o CLINIC (la clínica cancela o reprograma; nunca tardía).',
  })
  @IsIn(STAFF_CANCELLATION_KINDS, {
    message: CANCELLATION_MESSAGES.byKindRequired,
  })
  cancelledByKind!: StaffCancellationKind;

  @ApiProperty({
    enum: CancellationReasonCode,
    description:
      'Motivo del catálogo, como en `PATCH /appointments/:id`. El aviso y si es tardía se calculan por cita contra la política vigente de su sede.',
  })
  @IsEnum(CancellationReasonCode, {
    message: CANCELLATION_MESSAGES.reasonRequired,
  })
  cancelReasonCode!: CancellationReasonCode;

  @ApiPropertyOptional({
    maxLength: CANCEL_REASON_TEXT_MAX,
    description:
      'Detalle opcional del motivo (hasta 500 caracteres). No pidas datos de salud.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: CANCELLATION_MESSAGES.reasonText })
  @MaxLength(CANCEL_REASON_TEXT_MAX, {
    message: CANCELLATION_MESSAGES.reasonText,
  })
  cancelReasonText?: string;
}

/** DX-562 (D6): mover «esta y las siguientes». */
export class MoveAppointmentSeriesDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'La cita pivote (pendiente y futura) de esta serie: va a `start`; ella y las siguientes pendientes se desplazan los mismos días y toman la nueva hora de pared (zona de la sede), cada una con su duración.',
  })
  @IsUUID()
  fromAppointmentId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  start!: string;
}

// ---------------------------------------------------------------------------
// Respuestas
// ---------------------------------------------------------------------------

export class SeriesHolidayDto {
  @ApiProperty({ example: '2027-02-08' })
  date!: string;

  @ApiProperty({ example: 'Carnaval' })
  name!: string;
}

export class SeriesConflictReasonDto {
  @ApiProperty({
    enum: SERIES_CONFLICT_CODES,
    enumName: 'SeriesConflictCode',
    description:
      'PAST (ya pasó), BUSINESS_HOURS (fuera del horario de la sede), LOCATION_HOLIDAY (festivo de la sede), PROVIDER_OFF_SCHEDULE (fuera del horario del profesional en modo estricto), SCHEDULE_BLOCKED (bloqueo que no deja agendar), RESERVED_SLOT (hueco reservado para otros tipos), PROVIDER_OVERLAP / PATIENT_OVERLAP / CHAIR_OVERLAP (otra cita del profesional, del paciente o en el sillón), SERIES_OVERLAP (choca con otra fecha de la misma serie).',
  })
  code!: SeriesConflictCode;

  @ApiProperty({
    description: 'El texto en español de la regla, el mismo de la cita suelta.',
  })
  message!: string;

  @ApiPropertyOptional({ type: () => SeriesHolidayDto })
  holiday?: SeriesHolidayDto;
}

export class SeriesSlotDto {
  @ApiProperty({ format: 'date-time' })
  start!: Date;

  @ApiProperty({ format: 'date-time' })
  end!: Date;
}

export class SeriesPreviewOccurrenceDto {
  @ApiProperty({
    minimum: 1,
    maximum: 26,
    description: 'Posición en la serie (al crear: 1..n de la propuesta).',
  })
  index!: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Al mover: la cita de la serie.',
  })
  appointmentId?: string;

  @ApiPropertyOptional({
    type: () => SeriesSlotDto,
    description: 'Al mover: dónde está ahora.',
  })
  from?: SeriesSlotDto;

  @ApiProperty({ format: 'date-time' })
  start!: Date;

  @ApiProperty({ format: 'date-time' })
  end!: Date;

  @ApiProperty({ enum: ['OK', 'CONFLICT'] })
  status!: 'OK' | 'CONFLICT';

  @ApiProperty({
    type: [SeriesConflictReasonDto],
    description: 'Todas las reglas que impiden esa fecha (vacío si OK).',
  })
  reasons!: SeriesConflictReasonDto[];

  @ApiProperty({
    type: [String],
    description: 'Avisos que no la impiden (como al agendar), solo si OK.',
  })
  warnings!: string[];

  @ApiProperty({
    enum: APPOINTMENT_WARNING_CODES,
    enumName: 'AppointmentWarningCode',
    isArray: true,
  })
  warningCodes!: AppointmentWarningCode[];

  @ApiProperty({
    type: () => SeriesSlotDto,
    nullable: true,
    description:
      'Si choca: el hueco libre del MISMO día más cercano a esa hora, para ese profesional, sillón y duración («Usar 15:30»); null si no queda ninguno o es festivo. Confirmar lo vuelve a revisar.',
  })
  alternative!: SeriesSlotDto | null;
}

export class AppointmentSeriesPreviewDto {
  @ApiProperty({ example: 'America/Caracas' })
  timeZone!: string;

  @ApiProperty({ example: 45 })
  durationMinutes!: number;

  @ApiProperty({ type: [SeriesPreviewOccurrenceDto] })
  occurrences!: SeriesPreviewOccurrenceDto[];
}

export class CreatedAppointmentSeriesDto {
  @ApiProperty({ format: 'uuid' })
  seriesId!: string;

  @ApiProperty({ minimum: 1, maximum: 12 })
  intervalWeeks!: number;

  @ApiProperty({
    type: [AppointmentDto],
    description: 'Las citas creadas, por posición (con `series`).',
  })
  appointments!: AppointmentDto[];

  @ApiProperty({
    description: 'Si se encoló el aviso único al paciente.',
  })
  patientNotified!: boolean;

  @ApiProperty({
    enum: SERIES_NOTIFY_SKIP_REASONS,
    enumName: 'SeriesNotifySkipReason',
    nullable: true,
    description:
      'Si no se encoló el aviso, por qué (`null` si se encoló): DISABLED (`notifyPatient: false`); OPTED_OUT, CHANNEL_NONE, CHANNEL_WHATSAPP, NO_EMAIL (la regla de los envíos automáticos, DX-128/DX-203); QUOTA (el tope de emails de la clínica o del destinatario, comprobado en la misma transacción: la serie se crea igual, sin aviso); UNAVAILABLE (no se pudo preparar, p. ej. la sede sin formato regional). Encolado, queda además en el registro de envíos del paciente (`outbound_messages`, con la primera cita).',
  })
  notifyReason!: SeriesNotifySkipReason | null;
}

export class AppointmentSeriesChangeDto {
  @ApiProperty({ format: 'uuid' })
  seriesId!: string;

  @ApiProperty({
    type: [AppointmentDto],
    description:
      'Las citas canceladas o movidas, por posición (vacío si no había ninguna pendiente que cancelar).',
  })
  appointments!: AppointmentDto[];
}

export class SeriesConflictItemDto {
  @ApiProperty({
    minimum: 1,
    maximum: 26,
    description:
      'Al crear: la posición de esa fecha en la vista previa (la propuesta), la misma que `occurrences[].index` del preview, aunque se omitieran otras. Al mover: la posición de la cita en la serie (`series.index`).',
  })
  index!: number;

  @ApiPropertyOptional({ format: 'uuid' })
  appointmentId?: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'Al crear: el inicio ENVIADO para esa fecha (tal cual). Al mover: el nuevo inicio propuesto.',
  })
  start!: string;

  @ApiProperty({ format: 'date-time' })
  end!: string;

  @ApiProperty({ type: [SeriesConflictReasonDto] })
  reasons!: SeriesConflictReasonDto[];
}

/** Cuerpo del 409 `APPOINTMENT_SERIES_CONFLICT` (solo documentación). */
export class AppointmentSeriesConflictDto {
  @ApiProperty({ example: 409 })
  statusCode!: number;

  @ApiProperty({ enum: [APPOINTMENT_SERIES_CONFLICT_CODE] })
  code!: typeof APPOINTMENT_SERIES_CONFLICT_CODE;

  @ApiProperty()
  message!: string;

  @ApiProperty({
    type: [SeriesConflictItemDto],
    description:
      'Las fechas que chocan, con su posición y sus razones. Vacío si otra escritura a la vez no dejó terminar (reintentar).',
  })
  conflicts!: SeriesConflictItemDto[];
}
