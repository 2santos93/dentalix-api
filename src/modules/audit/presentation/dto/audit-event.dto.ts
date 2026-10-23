import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AuditAction, AuditResourceType, ClinicRole } from '@prisma/client';
import { AUDIT_ORIGINS, type AuditOrigin } from '../../domain/audit-metadata';

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
