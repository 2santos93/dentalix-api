import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

// NOTE: deliberately NO `tenantId`/`status`/`createdById` field — the tenant
// comes from the guarded request context (never the client, same convention
// as CreatePatientDto/CreateToothRecordDto); `status` always starts at the
// schema default (SCHEDULED); `createdById` is sourced from the authenticated
// user in the controller (req.user.sub), never from the client body.
export class CreateAppointmentDto {
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description:
      'Ítems aceptados del mismo paciente para esta cita (DX-256). [] desvincula al editar.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  planItemIds?: string[];

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  patientId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Profesional de la cita. DX-211: opcional si viene `chairId` con profesional por defecto (se toma el del sillón); el elegido manda siempre. Sin ninguno, 400.',
  })
  @IsOptional()
  @IsUUID()
  providerId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'DX-211: sillón de la cita. De esta clínica (si no, 404), de la sede de la cita y activo (si no, 400). Otra cita viva en ese sillón y franja: 409 «El sillón X ya está ocupado de HH:MM a HH:MM» (horas de la sede). Sin él, nada cambia.',
  })
  @IsOptional()
  @IsUUID()
  chairId?: string;

  @ApiProperty({ type: String, format: 'date-time' })
  @IsDateString()
  start!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description:
      'Opcional si viene `appointmentTypeId`: entonces la hora de fin es `start` + la duración del tipo (DX-121).',
  })
  @IsOptional()
  @IsDateString()
  end?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Tipo de cita (DX-121): de esta clínica y activo; si no, 400. Fija la duración si no viene `end`.',
  })
  @IsOptional()
  @IsUUID()
  appointmentTypeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({
    description:
      'DX-210: «Adelantar si hay hueco». La cita sale como candidata para los huecos libres de días anteriores de su sede y profesional. Solo RECEPTION, DENTIST y ADMIN (403 para ASSISTANT); queda auditado.',
  })
  @IsOptional()
  @IsBoolean()
  wantsEarlier?: boolean;

  @ApiPropertyOptional({
    minLength: 5,
    maxLength: 300,
    description:
      'DX-446: «Agendar igualmente» en un hueco reservado (bloque RESERVED) con un tipo no permitido y sin liberar. Solo ADMIN y DENTIST (403 para el resto); 5–300 caracteres en una línea. El motivo queda en `appointment_reserved_overrides`; `audit_event` (`reservedSlotOverride`) solo guarda el id de esa fila y los bloques.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300, {
    message:
      'El motivo para agendar en un hueco reservado debe tener entre 5 y 300 caracteres.',
  })
  overrideReason?: string;
}
