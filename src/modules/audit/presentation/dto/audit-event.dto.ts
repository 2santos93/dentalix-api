import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AuditAction, AuditResourceType, ClinicRole } from '@prisma/client';
import {
  AUDIT_CANCELLATION_KINDS,
  AUDIT_CANCELLATION_REASONS,
  AUDIT_ORIGINS,
  type AuditCancellation,
  type AuditOrigin,
} from '../../domain/audit-metadata';

// Forma de la respuesta de `GET /audit-events` (DX-009). Solo documenta el
// contrato en Swagger (de ahí sale el tipo del cliente web), no valida entrada.

export class AuditActorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '`null` si el usuario ya no es resoluble en esta clínica.',
  })
  fullName!: string | null;

  @ApiProperty({
    enum: ClinicRole,
    enumName: 'ClinicRole',
    nullable: true,
    description:
      'Rol con el que actuó (del token). `null` en un login fallido.',
  })
  role!: ClinicRole | null;
}

export class AuditPatientDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Ana Gómez', description: 'Nombre y apellido' })
  fullName!: string;
}

export class AuditAppointmentSlotDto {
  @ApiProperty({ format: 'date-time' })
  start!: string;

  @ApiProperty({ format: 'date-time' })
  end!: string;

  @ApiProperty({ format: 'uuid' })
  providerId!: string;
}

export class AuditAppointmentMoveDto {
  @ApiProperty({ type: AuditAppointmentSlotDto })
  from!: AuditAppointmentSlotDto;

  @ApiProperty({ type: AuditAppointmentSlotDto })
  to!: AuditAppointmentSlotDto;
}

export class AuditSearchDto {
  @ApiPropertyOptional({ example: 'LOT-AB12' })
  lot?: string;

  @ApiPropertyOptional({ example: '021.5310' })
  reference?: string;

  @ApiProperty({ example: 2 })
  rows!: number;
}

export class AuditStatusChangeDto {
  @ApiProperty({ example: 'CONFIRMED' })
  from!: string;

  @ApiProperty({ example: 'ARRIVED' })
  to!: string;
}

/** Un tramo del horario de un profesional en la auditoría (DX-233). */
export class AuditScheduleEntryDto {
  @ApiProperty({ format: 'uuid' })
  locationId!: string;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 6,
    description: 'Tramo semanal: 0 = domingo … 6 = sábado.',
  })
  weekday?: number;

  @ApiPropertyOptional({
    example: '2026-10-22',
    description: 'Excepción: fecha civil de la sede.',
  })
  date?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 1440 })
  startMinute?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1440 })
  endMinute?: number;

  @ApiPropertyOptional({
    enum: [true],
    description: 'Excepción «no trabaja».',
  })
  off?: true;
}

export class AuditScheduleChangeDto {
  @ApiProperty({ type: [AuditScheduleEntryDto] })
  before!: AuditScheduleEntryDto[];

  @ApiProperty({ type: [AuditScheduleEntryDto] })
  after!: AuditScheduleEntryDto[];
}

export class AuditCurrencyTotalDto {
  @ApiProperty({ example: 'COP' }) currency!: string;
  @ApiProperty({ description: 'Filas del archivo' }) rows!: number;
  @ApiProperty({ example: 1500000 }) amount!: number;
}

export class AuditImportBatchDto {
  @ApiProperty({ description: 'SHA-256 (hex) del archivo importado' })
  fileSha256!: string;
  @ApiPropertyOptional({ enum: ['SKIP', 'FILL_EMPTY'] })
  mode?: 'SKIP' | 'FILL_EMPTY';
  @ApiPropertyOptional() rows?: number;
  @ApiPropertyOptional() valid?: number;
  @ApiPropertyOptional() duplicates?: number;
  @ApiPropertyOptional() errors?: number;
  @ApiPropertyOptional() created?: number;
  @ApiPropertyOptional() updated?: number;
  @ApiPropertyOptional() undoneCreated?: number;
  @ApiPropertyOptional() undoneFilled?: number;
  @ApiPropertyOptional({
    description: 'DX-262: SHA-256 (hex) de la hoja de saldos',
  })
  balanceFileSha256?: string;
  @ApiPropertyOptional() balanceRows?: number;
  @ApiPropertyOptional() balanceErrors?: number;
  @ApiPropertyOptional() balancesCreated?: number;
  @ApiPropertyOptional({
    description:
      '«Añadir aunque ya tenga saldo migrado» marcado (DX-262, QA D1)',
  })
  balanceAddToExisting?: boolean;
  @ApiPropertyOptional({
    description:
      'Saldos no creados porque el paciente ya tenía uno vivo en esa moneda (DX-262, QA D1)',
  })
  balancesExisting?: number;
  @ApiPropertyOptional() balancesUndone?: number;
  @ApiPropertyOptional({
    type: [AuditCurrencyTotalDto],
    description:
      'DX-262: total por moneda de los saldos migrados del lote (agregado, sin convertir)',
  })
  balanceTotals?: AuditCurrencyTotalDto[];
  @ApiPropertyOptional({
    type: [AuditCurrencyTotalDto],
    description: 'DX-262: lo que retiró de verdad el deshacer, por moneda',
  })
  balanceUndoneTotals?: AuditCurrencyTotalDto[];
}

/** Un lado de la atribución de un ítem realizado (DX-050). */
export class AuditAttributionSideDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  performedById!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  locationId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt!: string | null;
}

export class AuditAttributionChangeDto {
  @ApiProperty({ type: AuditAttributionSideDto })
  before!: AuditAttributionSideDto;

  @ApiProperty({ type: AuditAttributionSideDto })
  after!: AuditAttributionSideDto;
}

/** DX-279: cancelación de una cita desde la agenda (solo códigos y números). */
export class AuditCancellationDto {
  @ApiProperty({
    enum: AUDIT_CANCELLATION_KINDS,
    enumName: 'AuditCancellationKind',
  })
  byKind!: AuditCancellation['byKind'];

  @ApiProperty({
    enum: AUDIT_CANCELLATION_REASONS,
    enumName: 'AuditCancellationReason',
    nullable: true,
  })
  reasonCode!: AuditCancellation['reasonCode'];

  @ApiProperty({ example: 300 })
  noticeMinutes!: number;

  @ApiProperty()
  lateCancellation!: boolean;
}

/** Un lado del cambio del nº de registro sanitario de una sede (DX-319). */
export class AuditHealthRegistrationSideDto {
  @ApiProperty({ type: String, nullable: true, maxLength: 64 })
  number!: string | null;

  @ApiProperty({ description: 'Si el nº sale en los documentos de la sede.' })
  shown!: boolean;
}

export class AuditHealthRegistrationChangeDto {
  @ApiProperty({ type: AuditHealthRegistrationSideDto })
  before!: AuditHealthRegistrationSideDto;

  @ApiProperty({ type: AuditHealthRegistrationSideDto })
  after!: AuditHealthRegistrationSideDto;
}

/** Un lado del cambio de accesos de un miembro (DX-359). */
export class AuditStaffAccessSideDto {
  @ApiPropertyOptional({ enum: ClinicRole, enumName: 'ClinicRole' })
  role?: ClinicRole;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    nullable: true,
    description: 'Sedes permitidas; `null` = todas.',
  })
  locationIds?: string[] | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 60 })
  professionalLicense?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 80 })
  professionalSpecialty?: string | null;
}

export class AuditStaffAccessChangeDto {
  @ApiPropertyOptional({ type: AuditStaffAccessSideDto })
  before?: AuditStaffAccessSideDto;

  @ApiPropertyOptional({ type: AuditStaffAccessSideDto })
  after?: AuditStaffAccessSideDto;
}

export class AuditMetadataDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'UPDATE: nombres de los campos enviados (nunca sus valores).',
  })
  changedFields?: string[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Parámetros de la ruta (ids).',
  })
  params?: Record<string, string>;

  @ApiPropertyOptional({ example: 'INVALID_CREDENTIALS' })
  reason?: string;

  @ApiPropertyOptional({
    type: AuditAppointmentMoveDto,
    description:
      'DX-121: cita movida — hora y profesional antes y después (nunca datos del paciente).',
  })
  move?: AuditAppointmentMoveDto;

  @ApiPropertyOptional({
    type: AuditStatusChangeDto,
    description:
      'DX-200: paso del flujo en la clínica (`reason` PATIENT_FLOW o ARRIVAL_UNDONE): estado de la cita antes y después.',
  })
  status?: AuditStatusChangeDto;

  @ApiPropertyOptional({
    enum: AUDIT_ORIGINS,
    enumName: 'AuditOrigin',
    description:
      'DX-128: de dónde salió un cambio de canal, opt-in o baja de recordatorios (en persona, enlace, mensaje del paciente o anotado por el personal).',
  })
  origin?: AuditOrigin;

  @ApiPropertyOptional({
    type: AuditSearchDto,
    description:
      'DX-191: búsqueda de implantes por lote/REF — lo buscado y cuántas filas salieron.',
  })
  search?: AuditSearchDto;

  @ApiPropertyOptional({
    type: AuditStatusChangeDto,
    description:
      'DX-215: estado antes y después (p. ej. un compromiso de pago cumplido que vuelve a abierto al anular su abono). Solo códigos.',
  })
  statusChange?: AuditStatusChangeDto;

  @ApiPropertyOptional({
    type: AuditScheduleChangeDto,
    description:
      'DX-233: horario de un profesional antes y después (semanal o una excepción por fecha): sedes, días, fechas y minutos.',
  })
  scheduleChange?: AuditScheduleChangeDto;

  @ApiPropertyOptional({
    type: AuditImportBatchDto,
    description:
      'DX-107: lote de importación de pacientes — hash del archivo, modo de duplicados y totales (solo números).',
  })
  importBatch?: AuditImportBatchDto;

  @ApiPropertyOptional({
    type: AuditAttributionChangeDto,
    description:
      'DX-050: quién realizó un ítem del plan, en qué sede y cuándo, antes y después (`reason` PLAN_ITEM_ATTRIBUTION_CORRECTED o PLAN_ITEM_DONE_REVERTED). Solo ids e instantes.',
  })
  attribution?: AuditAttributionChangeDto;

  @ApiPropertyOptional({
    type: AuditCancellationDto,
    description:
      'DX-279: cita cancelada desde la agenda, en su único evento (`reason` APPOINTMENT_CANCELLED; PATIENT_FLOW si estaba en la clínica; COMPLETED_EXIT si estaba completada): quién, código del motivo, minutos de aviso y si fue tardía. Nunca el texto libre del motivo.',
  })
  cancellation?: AuditCancellationDto;

  @ApiPropertyOptional({
    type: AuditHealthRegistrationChangeDto,
    description:
      'DX-319: nº de registro sanitario de una sede y si sale en los documentos, antes y después (dato público de la sede, nunca de un paciente).',
  })
  healthRegistration?: AuditHealthRegistrationChangeDto;

  @ApiPropertyOptional({
    type: AuditStaffAccessChangeDto,
    description:
      'DX-359: accesos de un miembro antes y después (rol, sedes, nº de registro profesional, especialidad): solo lo que cambió, o un lado en un alta (invitación, aceptación, registro). Nunca el nombre, el email ni nada de la contraseña.',
  })
  staffAccess?: AuditStaffAccessChangeDto;
}

export class AuditEventDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'date-time' })
  occurredAt!: Date;

  @ApiProperty({ enum: AuditAction, enumName: 'AuditAction' })
  action!: AuditAction;

  @ApiProperty({ enum: AuditResourceType, enumName: 'AuditResourceType' })
  resourceType!: AuditResourceType;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  resourceId!: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Sede activa de la petición; `null` = vista consolidada.',
  })
  locationId!: string | null;

  @ApiProperty({
    example: 'America/Bogota',
    description:
      'Zona IANA de la sede del evento (o de la sede principal): la hora se ' +
      'muestra en ella.',
  })
  timeZone!: string;

  @ApiProperty({ type: AuditActorDto, nullable: true })
  actor!: AuditActorDto | null;

  @ApiProperty({ type: AuditPatientDto, nullable: true })
  patient!: AuditPatientDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'X-Request-Id de la petición: la enlaza con su línea de log.',
  })
  requestId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  ip!: string | null;

  @ApiProperty({ type: String, nullable: true })
  userAgent!: string | null;

  @ApiProperty({ type: AuditMetadataDto })
  metadata!: AuditMetadataDto;
}

export class AuditEventsPageDto {
  @ApiProperty({ type: [AuditEventDto] })
  items!: AuditEventDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Cursor de la página siguiente; `null` en la última.',
  })
  nextCursor!: string | null;

  @ApiProperty({
    example: 'America/Bogota',
    description:
      'Zona de la sede activa (o de la principal), para interpretar los ' +
      'días de los filtros.',
  })
  timeZone!: string;
}
