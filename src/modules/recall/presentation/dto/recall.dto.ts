import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  RecallContactChannel,
  RecallContactOutcome,
  RecallKind,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  RECALL_DEFAULT_PAGE_SIZE,
  RECALL_DISABLED_REASON_MAX,
  RECALL_MAX_PAGE_SIZE,
  RECALL_NOTE_MAX,
  type RecallDueSort,
} from '../../domain/recall.entity';
import {
  RECALL_INTERVAL_MAX,
  RECALL_INTERVAL_MIN,
  RECALL_WITHIN_DAYS_MAX,
} from '../../domain/recall-rules';

const MAX_PAGE = 100000;
const SORTS: RecallDueSort[] = ['MOST_OVERDUE', 'LEAST_OVERDUE'];
const RECALL_STATUSES = [
  'DUE',
  'UPCOMING',
  'SCHEDULED',
  'PAUSED',
  'INACTIVE',
] as const;

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

/** Filtros comunes de la lista y de su recuento. */
export class RecallDueCountQueryDto {
  @ApiPropertyOptional({
    enum: RecallKind,
    enumName: 'RecallKind',
    description: 'Solo un tipo de recall (higiene o control)',
  })
  @IsOptional()
  @IsEnum(RecallKind, { message: 'kind debe ser HYGIENE o CHECKUP.' })
  kind?: RecallKind;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: RECALL_WITHIN_DAYS_MAX,
    default: 0,
    description:
      'Incluir también los que vencen en los próximos N días (0 = solo los ya vencidos)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'withinDays debe ser un número entero de días.' })
  @Min(0, { message: 'withinDays no puede ser negativo.' })
  @Max(RECALL_WITHIN_DAYS_MAX, {
    message: `withinDays admite hasta ${RECALL_WITHIN_DAYS_MAX} días.`,
  })
  withinDays?: number;
}

export class RecallDueQueryDto extends RecallDueCountQueryDto {
  @ApiPropertyOptional({
    enum: SORTS,
    enumName: 'RecallDueSort',
    default: 'MOST_OVERDUE',
    description: 'Por días de vencido: los más vencidos primero o al revés',
  })
  @IsOptional()
  @IsIn(SORTS, { message: 'sort debe ser MOST_OVERDUE o LEAST_OVERDUE.' })
  sort?: RecallDueSort;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page debe ser un número entero.' })
  @Min(1, { message: 'page empieza en 1.' })
  @Max(MAX_PAGE, { message: `page admite hasta ${MAX_PAGE}.` })
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: RECALL_MAX_PAGE_SIZE,
    default: RECALL_DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize debe ser un número entero.' })
  @Min(1, { message: 'pageSize empieza en 1.' })
  @Max(RECALL_MAX_PAGE_SIZE, {
    message: `pageSize admite hasta ${RECALL_MAX_PAGE_SIZE}.`,
  })
  pageSize?: number;
}

export class SetPatientRecallDto {
  @ApiProperty({
    minimum: RECALL_INTERVAL_MIN,
    maximum: RECALL_INTERVAL_MAX,
    example: 6,
    description:
      'Cada cuántos meses vuelve (p. ej. 6 = «control cada 6 meses»)',
  })
  @Type(() => Number)
  @IsInt({ message: 'intervalMonths debe ser un número entero de meses.' })
  @Min(RECALL_INTERVAL_MIN, {
    message: `El intervalo va de ${RECALL_INTERVAL_MIN} a ${RECALL_INTERVAL_MAX} meses.`,
  })
  @Max(RECALL_INTERVAL_MAX, {
    message: `El intervalo va de ${RECALL_INTERVAL_MIN} a ${RECALL_INTERVAL_MAX} meses.`,
  })
  intervalMonths!: number;

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-04-10',
    description:
      'Día del último control o limpieza (AAAA-MM-DD, no futuro). Por defecto, hoy en la sede.',
  })
  @IsOptional()
  @IsString({ message: 'lastDoneAt debe ser una fecha (AAAA-MM-DD).' })
  lastDoneAt?: string;

  @ApiPropertyOptional({
    default: true,
    description: '`false` retira el recall: deja de salir en la lista',
  })
  @IsOptional()
  @IsBoolean({ message: 'active debe ser verdadero o falso.' })
  active?: boolean;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    nullable: true,
    description:
      'Pausa hasta ese día (posterior a hoy), p. ej. «tratamiento en curso». `null` la quita.',
  })
  @IsOptional()
  @IsString({ message: 'disabledUntil debe ser una fecha (AAAA-MM-DD).' })
  disabledUntil?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: RECALL_DISABLED_REASON_MAX,
    description: 'Motivo corto de la pausa (sin datos clínicos)',
  })
  @IsOptional()
  @IsString({ message: 'disabledReason debe ser un texto.' })
  @MaxLength(RECALL_DISABLED_REASON_MAX, {
    message: `El motivo admite hasta ${RECALL_DISABLED_REASON_MAX} caracteres.`,
  })
  disabledReason?: string | null;
}

export class CreateRecallContactDto {
  @ApiProperty({
    enum: RecallContactChannel,
    enumName: 'RecallContactChannel',
    description: 'Llamada, enlace de WhatsApp, email o en persona',
  })
  @IsEnum(RecallContactChannel, {
    message: 'channel debe ser CALL, WHATSAPP_LINK, EMAIL o IN_PERSON.',
  })
  channel!: RecallContactChannel;

  @ApiProperty({
    enum: RecallContactOutcome,
    enumName: 'RecallContactOutcome',
    description:
      'No contesta, dejó mensaje, llamar luego, agendará, rechaza, número erróneo o agendó (con la cita)',
  })
  @IsEnum(RecallContactOutcome, {
    message:
      'outcome debe ser NO_ANSWER, LEFT_MESSAGE, CALL_BACK, WILL_BOOK, DECLINED, WRONG_NUMBER o BOOKED.',
  })
  outcome!: RecallContactOutcome;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: RECALL_NOTE_MAX,
    description:
      'Nota corta (sin datos clínicos). No se edita ni se borra: una corrección es otro contacto.',
  })
  @IsOptional()
  @IsString({ message: 'note debe ser un texto.' })
  @MaxLength(RECALL_NOTE_MAX, {
    message: `La nota admite hasta ${RECALL_NOTE_MAX} caracteres.`,
  })
  note?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'La cita creada (obligatoria con BOOKED); del mismo paciente',
  })
  @IsOptional()
  @IsUUID('4', { message: 'appointmentId debe ser un UUID.' })
  appointmentId?: string | null;
}

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

export class RecallLastContactDto {
  @ApiProperty({ enum: RecallContactChannel, enumName: 'RecallContactChannel' })
  channel!: RecallContactChannel;

  @ApiProperty({ enum: RecallContactOutcome, enumName: 'RecallContactOutcome' })
  outcome!: RecallContactOutcome;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class RecallDueItemDto {
  @ApiProperty({ format: 'uuid' })
  recallId!: string;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty()
  patientName!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '`null` sin teléfono o con baja de avisos (DX-128)',
  })
  patientPhone!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'E.164 sin `+` para `https://wa.me/…` (región de la sede del paciente); `null` si no sirve o hay baja de avisos',
  })
  patientWhatsApp!: string | null;

  @ApiProperty({
    description:
      'DX-128: el paciente pidió no recibir avisos. Sigue en la lista, sin contacto.',
  })
  reminderOptedOut!: boolean;

  @ApiProperty({ enum: RecallKind, enumName: 'RecallKind' })
  kind!: RecallKind;

  @ApiProperty()
  intervalMonths!: number;

  @ApiProperty({
    format: 'date',
    description: 'Base del vencimiento: lo fijado o la última visita atendida',
  })
  baseDate!: string;

  @ApiProperty({ format: 'date' })
  dueAt!: string;

  @ApiProperty({
    description: 'Días desde el vencimiento (0 = vence hoy; negativo = faltan)',
  })
  daysOverdue!: number;

  @ApiProperty({
    format: 'uuid',
    description:
      'Sede del paciente: la de su última cita atendida o, sin ella, la del recall',
  })
  locationId!: string;

  @ApiProperty({ type: RecallLastContactDto, nullable: true })
  lastContact!: RecallLastContactDto | null;
}

export class RecallDuePageDto {
  @ApiProperty({ type: [RecallDueItemDto] })
  items!: RecallDueItemDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  pageSize!: number;
}

export class RecallDueCountDto {
  @ApiProperty({
    description: 'Pacientes por llamar con esos filtros (todas las páginas)',
  })
  total!: number;
}

export class RecallStaffRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, nullable: true })
  fullName!: string | null;
}

export class PatientRecallDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: RecallKind, enumName: 'RecallKind' })
  kind!: RecallKind;

  @ApiProperty()
  intervalMonths!: number;

  @ApiProperty({ format: 'date' })
  lastDoneAt!: string;

  @ApiProperty()
  active!: boolean;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  disabledUntil!: string | null;

  @ApiProperty({ type: String, nullable: true })
  disabledReason!: string | null;

  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiProperty({ format: 'date' })
  baseDate!: string;

  @ApiProperty({ format: 'date' })
  dueAt!: string;

  @ApiProperty()
  daysOverdue!: number;

  @ApiProperty({
    enum: RECALL_STATUSES,
    enumName: 'RecallStatus',
    description:
      'DUE: por llamar · UPCOMING: aún no vence · SCHEDULED: ya tiene cita · PAUSED: pausado hasta una fecha · INACTIVE: retirado',
  })
  status!: (typeof RECALL_STATUSES)[number];

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: RecallStaffRefDto })
  updatedBy!: RecallStaffRefDto;
}

export class RecallContactDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  recallId!: string;

  @ApiProperty({ enum: RecallKind, enumName: 'RecallKind' })
  kind!: RecallKind;

  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;

  @ApiProperty({ enum: RecallContactChannel, enumName: 'RecallContactChannel' })
  channel!: RecallContactChannel;

  @ApiProperty({ enum: RecallContactOutcome, enumName: 'RecallContactOutcome' })
  outcome!: RecallContactOutcome;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  appointmentId!: string | null;

  @ApiProperty({ type: RecallStaffRefDto })
  author!: RecallStaffRefDto;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class PatientRecallsDto {
  @ApiProperty({ type: [PatientRecallDto] })
  recalls!: PatientRecallDto[];

  @ApiProperty({
    type: [RecallContactDto],
    description: 'Historial de contactos, más recientes primero (hasta 50)',
  })
  contacts!: RecallContactDto[];
}
