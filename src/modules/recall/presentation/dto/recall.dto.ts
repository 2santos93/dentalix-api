import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  RecallContactChannel,
  RecallContactOutcome,
  RecallKind,
  RecallSource,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
  ValidateIf,
} from 'class-validator';
import {
  RECALL_EXCLUSION_GROUP,
  RECALL_EXCLUSION_GROUP_MESSAGE,
  RECALL_TYPE_INTERVAL_MESSAGE,
  RECALL_TYPE_NAME_MAX,
  RECALL_TYPE_NAME_TOO_LONG_MESSAGE,
  RECALL_TYPE_SORT_MAX,
  RECALL_TYPE_SORT_MESSAGE,
  RECALL_TYPE_SORT_MIN,
  RECALL_TYPE_TRIGGERS_MAX,
  RECALL_TYPE_TRIGGERS_MAX_MESSAGE,
} from '../../domain/recall-type-rules';
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
    description:
      'Compatibilidad: solo el tipo con esa clave (higiene o control). Mejor `recallTypeId`.',
  })
  @IsOptional()
  @IsEnum(RecallKind, { message: 'kind debe ser HYGIENE o CHECKUP.' })
  kind?: RecallKind;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'DX-015-bis: solo un tipo de recall de la clínica (GET /recall-types)',
  })
  @IsOptional()
  @IsUUID('4', { message: 'recallTypeId debe ser un UUID.' })
  recallTypeId?: string;

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

/** D17: «Sin recall configurado», paginada. */
export class RecallUnconfiguredQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo los pacientes cuya última cita atendida es de esta sede (tiene que estar entre las permitidas: 403 si no). Sin ella, la sede activa (X-Location-Id) o las permitidas.',
  })
  @IsOptional()
  @IsUUID('all', { message: 'locationId debe ser el id de una sede.' })
  locationId?: string;

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

/** D15: «Programar recall» con el intervalo por defecto del tipo. */
export class CreateDefaultRecallDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Tipo de recall de la clínica (GET /recall-types), vivo y activo. Se usa su intervalo por defecto.',
  })
  @IsUUID('all', {
    message: 'recallTypeId debe ser el id de un tipo de recall.',
  })
  recallTypeId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'La cita que se despide (salida del paciente). Tiene que ser de este paciente, viva y en llegada, en sillón, lista para la salida o atendida (si no, 422). Con ella, la base es el día civil de esa cita en la zona de su sede, y la sede es la suya. Sin ella, la última cita atendida del paciente (o hoy): el caso de «Sin recall configurado».',
  })
  @IsOptional()
  @IsUUID('all', { message: 'appointmentId debe ser el id de una cita.' })
  appointmentId?: string;
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
      'Día del último control o limpieza (AAAA-MM-DD, no futuro), fijado a mano. Por defecto: hoy en la sede al crear el recall; al editarlo, se conserva lo fijado (y la base que da un procedimiento).',
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

  @ApiProperty({
    enum: RecallKind,
    enumName: 'RecallKind',
    nullable: true,
    description:
      'DEPRECADO (DX-015-bis): la clave del tipo; null en los tipos sin clave. Usar `recallTypeId`.',
  })
  kind!: RecallKind | null;

  @ApiProperty({ format: 'uuid' })
  recallTypeId!: string;

  @ApiProperty({ description: 'Nombre del tipo (p. ej. «Higiene»)' })
  recallTypeName!: string;

  @ApiProperty()
  intervalMonths!: number;

  @ApiProperty({
    format: 'date',
    description:
      'Base del vencimiento: lo fijado a mano o el último procedimiento disparador realizado',
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

/** D17: un paciente sin recall configurado. */
export class RecallUnconfiguredItemDto {
  @ApiProperty({ format: 'uuid' })
  patientId!: string;

  @ApiProperty({ example: 'María Rondón' })
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
      'E.164 sin `+` para `https://wa.me/…` (región de la sede de la última visita); `null` si no sirve o hay baja de avisos',
  })
  patientWhatsApp!: string | null;

  @ApiProperty({
    description:
      'DX-128: el paciente pidió no recibir avisos. Sigue en la lista, sin contacto.',
  })
  reminderOptedOut!: boolean;

  @ApiProperty({
    format: 'date',
    example: '2027-03-15',
    description:
      'Día civil de la última cita atendida, en la zona de su sede (en los últimos 24 meses)',
  })
  lastVisitAt!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Sede de la última cita atendida: la del paciente',
  })
  lastVisitLocationId!: string;
}

export class RecallUnconfiguredPageDto {
  @ApiProperty({ type: [RecallUnconfiguredItemDto] })
  items!: RecallUnconfiguredItemDto[];

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

  @ApiProperty({
    enum: RecallKind,
    enumName: 'RecallKind',
    nullable: true,
    description:
      'DEPRECADO (DX-015-bis): la clave del tipo; null en los tipos sin clave. Usar `recallTypeId`.',
  })
  kind!: RecallKind | null;

  @ApiProperty({ format: 'uuid' })
  recallTypeId!: string;

  @ApiProperty({ description: 'Nombre del tipo (p. ej. «Higiene»)' })
  recallTypeName!: string;

  @ApiProperty()
  intervalMonths!: number;

  @ApiProperty({
    format: 'date',
    description:
      'Base del vencimiento: el máximo entre lo fijado a mano y el último procedimiento disparador realizado',
  })
  lastDoneAt!: string;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description:
      'Lo fijado a mano; null si el recall nació de un procedimiento',
  })
  manualDoneAt!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Ítem del plan realizado que da la base (si la da un procedimiento y no lo fijado)',
  })
  lastDoneItemId!: string | null;

  @ApiProperty({
    enum: RecallSource,
    enumName: 'RecallSource',
    description:
      'MANUAL: fijado a mano · PROCEDURE: lo creó un procedimiento realizado · BACKFILL: lo creó el relleno del historial',
  })
  source!: RecallSource;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description:
      'Relleno del despliegue de DX-015-bis: si no es null, `manualDoneAt` NO lo tecleó nadie (es la última visita atendida, que entonces movía el reloj) y esto es lo que había fijado el clínico. Se vuelve null al fijarlo de nuevo.',
  })
  preBackfillDoneAt!: string | null;

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

  @ApiProperty({
    format: 'date',
    description: 'Vencimiento guardado: base + intervalo',
  })
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

  @ApiProperty({
    enum: RecallKind,
    enumName: 'RecallKind',
    nullable: true,
    description: 'DEPRECADO (DX-015-bis): usar `recallTypeId`.',
  })
  kind!: RecallKind | null;

  @ApiProperty({ format: 'uuid' })
  recallTypeId!: string;

  @ApiProperty()
  recallTypeName!: string;

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

/** DX-015-bis: un procedimiento disparador de un tipo. */
export class RecallTypeTriggerDto {
  @ApiProperty({ format: 'uuid' })
  catalogItemId!: string;

  @ApiProperty({ example: 'PREV-PROFILAXIS' })
  code!: string;

  @ApiProperty({
    example: 'Profilaxis',
    description: 'Nombre del procedimiento en el catálogo de la clínica',
  })
  name!: string;
}

export class RecallTypeDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Higiene' })
  name!: string;

  @ApiProperty({
    minimum: RECALL_INTERVAL_MIN,
    maximum: RECALL_INTERVAL_MAX,
    description: 'Intervalo de los recalls que crea un procedimiento realizado',
  })
  defaultIntervalMonths!: number;

  @ApiProperty()
  active!: boolean;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty({
    enum: RecallKind,
    enumName: 'RecallKind',
    nullable: true,
    description: 'Clave de compatibilidad (rutas `:kind`); null si no tiene',
  })
  systemKey!: RecallKind | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Tipos excluyentes entre sí (p. ej. HYGIENE_PERIO)',
  })
  exclusionGroup!: string | null;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'Procedimientos del catálogo cuyo DONE mueve el reloj de este tipo',
  })
  triggerCatalogItemIds!: string[];

  @ApiProperty({
    type: [RecallTypeTriggerDto],
    description:
      'Los mismos procedimientos, con su código y su nombre (en el orden de triggerCatalogItemIds)',
  })
  triggers!: RecallTypeTriggerDto[];
}

/**
 * DX-015-bis (D11): alta de un tipo de recall (ADMIN). Sin `tenantId`: sale
 * del contexto del request.
 */
export class CreateRecallTypeDto {
  @ApiProperty({ minLength: 1, maxLength: RECALL_TYPE_NAME_MAX })
  @IsString()
  @MaxLength(RECALL_TYPE_NAME_MAX, {
    message: RECALL_TYPE_NAME_TOO_LONG_MESSAGE,
  })
  name!: string;

  @ApiProperty({
    minimum: RECALL_INTERVAL_MIN,
    maximum: RECALL_INTERVAL_MAX,
    description:
      'Intervalo de los recalls que cree un procedimiento a partir de ahora (cambiarlo no mueve los que ya existen)',
  })
  @IsInt({ message: RECALL_TYPE_INTERVAL_MESSAGE })
  @Min(RECALL_INTERVAL_MIN, { message: RECALL_TYPE_INTERVAL_MESSAGE })
  @Max(RECALL_INTERVAL_MAX, { message: RECALL_TYPE_INTERVAL_MESSAGE })
  defaultIntervalMonths!: number;

  @ApiPropertyOptional({
    description:
      'Por defecto, true. false: deja de crear recalls por procedimiento; los que hay siguen en la lista',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({
    minimum: RECALL_TYPE_SORT_MIN,
    maximum: RECALL_TYPE_SORT_MAX,
    description: 'Orden en las listas; por defecto, el último',
  })
  @IsOptional()
  @IsInt({ message: RECALL_TYPE_SORT_MESSAGE })
  @Min(RECALL_TYPE_SORT_MIN, { message: RECALL_TYPE_SORT_MESSAGE })
  @Max(RECALL_TYPE_SORT_MAX, { message: RECALL_TYPE_SORT_MESSAGE })
  sortOrder?: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: RECALL_EXCLUSION_GROUP.source,
    example: 'HYGIENE_PERIO',
    description:
      'Grupo de exclusión (D9/D13): dos recalls de un paciente de tipos del mismo grupo no están activos a la vez. null = sin exclusión',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString({ message: RECALL_EXCLUSION_GROUP_MESSAGE })
  @Matches(RECALL_EXCLUSION_GROUP, { message: RECALL_EXCLUSION_GROUP_MESSAGE })
  exclusionGroup?: string | null;
}

/** D11: editar cualquier campo (solo los presentes). */
export class UpdateRecallTypeDto extends PartialType(CreateRecallTypeDto) {}

/** D12: el conjunto completo de procedimientos que disparan el tipo. */
export class SetRecallTypeTriggersDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    maxItems: RECALL_TYPE_TRIGGERS_MAX,
    description:
      'Reemplaza los disparadores: procedimientos vivos del catálogo de la clínica (o los que el tipo ya tenía). [] los quita todos',
  })
  @IsArray()
  @ArrayMaxSize(RECALL_TYPE_TRIGGERS_MAX, {
    message: RECALL_TYPE_TRIGGERS_MAX_MESSAGE,
  })
  @IsUUID('all', {
    each: true,
    message: 'Cada procedimiento debe ser un id válido.',
  })
  catalogItemIds!: string[];
}

/** D9: el tipo del recall que sustituye al desactivado. */
export class RecallReplacementTypeDto {
  @ApiProperty({ format: 'uuid' })
  recallTypeId!: string;

  @ApiProperty({ example: 'Mantenimiento periodontal' })
  recallTypeName!: string;
}

/** D9: un recall que la exclusión desactivó al fijar otro (PUT). */
export class RecallExclusionUpdateDto {
  @ApiProperty({ format: 'uuid' })
  recallId!: string;

  @ApiProperty({ format: 'uuid' })
  recallTypeId!: string;

  @ApiProperty({ example: 'Higiene' })
  recallTypeName!: string;

  @ApiProperty({ format: 'date', description: 'Vencimiento (no cambia)' })
  dueAt!: string;

  @ApiProperty({ description: 'Siempre true (como en el PATCH del ítem)' })
  deactivated!: boolean;

  @ApiProperty({ type: RecallReplacementTypeDto })
  replacedBy!: RecallReplacementTypeDto;
}

/** Respuesta del PUT del recall: la ficha y lo que desactivó la exclusión. */
export class SetPatientRecallResultDto extends PatientRecallsDto {
  @ApiProperty({
    type: [RecallExclusionUpdateDto],
    description:
      'D9: recalls de tipos del mismo grupo de exclusión que este alta o reactivación desactivó («Recall de Higiene desactivado: lo sustituye Mantenimiento periodontal»); vacío si ninguno',
  })
  recallUpdates!: RecallExclusionUpdateDto[];
}
