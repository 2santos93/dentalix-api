import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

// NOTE: deliberately NO `tenantId`/`status`/`createdById` field — the tenant
// comes from the guarded request context (never the client, same convention
// as CreatePatientDto/CreateToothRecordDto); `status` always starts at the
// schema default (SCHEDULED); `createdById` is sourced from the authenticated
// user in the controller (req.user.sub), never from the client body.
export class CreateAppointmentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  patientId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  providerId!: string;

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
}
