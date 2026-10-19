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
  @ApiProperty({ example: 'KEPT' })
  from!: string;

  @ApiProperty({ example: 'OPEN' })
  to!: string;
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
