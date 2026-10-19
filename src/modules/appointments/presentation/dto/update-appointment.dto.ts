import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { AppointmentStatus } from '@prisma/client';

// All fields optional (partial update: reschedule start/end and/or change
// status — e.g. CONFIRMED, or "cancel" = CANCELLED, never a hard delete).
// NO `tenantId` field — same rationale as UpdatePatientDto.
export class UpdateAppointmentDto {
  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @IsDateString()
  start?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @IsDateString()
  end?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'DX-121: mover la cita a otro profesional de la clínica. Mismas reglas que reagendar: solape 409, horario de la sede 422, y anula el enlace de confirmación.',
  })
  @IsOptional()
  @IsUUID()
  providerId?: string;

  @ApiPropertyOptional({
    enum: AppointmentStatus,
    description:
      'DX-200: flujo en la clínica sin saltos (409 si no): ARRIVED desde SCHEDULED/CONFIRMED y solo el día de la cita (RECEPTION, ASSISTANT, ADMIN; fija `arrivedAt`); IN_CHAIR desde ARRIVED y READY_FOR_CHECKOUT desde IN_CHAIR (DENTIST, ASSISTANT, ADMIN; fijan `seatedAt` / `readyForCheckoutAt`); la salida a COMPLETED (o CANCELLED si se fue sin pasar al sillón) desde el flujo, RECEPTION, ASSISTANT, ADMIN. Nunca NO_SHOW desde el flujo; para volver a agendada, `POST /appointments/:id/undo-arrival`. Las horas las pone el servidor. Rol sin permiso: 403.',
  })
  @IsOptional()
  @IsEnum(AppointmentStatus)
  status?: AppointmentStatus;

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
