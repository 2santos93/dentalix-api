import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { AppointmentStatus } from '@prisma/client';
import {
  PATIENT_FLOW_MESSAGES,
  STATUS_REASON_MAX,
  STATUS_REASON_MIN,
} from '../../domain/patient-flow';

// All fields optional (partial update: reschedule start/end and/or change
// status — e.g. CONFIRMED, or "cancel" = CANCELLED, never a hard delete).
// NO `tenantId` field — same rationale as UpdatePatientDto.
export class UpdateAppointmentDto {
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
      'DX-200: flujo en la clínica sin saltos (409 si no): ARRIVED desde SCHEDULED/CONFIRMED y solo el día de la cita (RECEPTION, ASSISTANT, ADMIN; fija `arrivedAt`); IN_CHAIR desde ARRIVED y READY_FOR_CHECKOUT desde IN_CHAIR (DENTIST, ASSISTANT, ADMIN; fijan `seatedAt` / `readyForCheckoutAt`); la salida a COMPLETED (o CANCELLED si se fue sin pasar al sillón) desde el flujo, RECEPTION, ASSISTANT, ADMIN. Nunca NO_SHOW desde el flujo; para volver a agendada, `POST /appointments/:id/undo-arrival`. Las horas las pone el servidor. Rol sin permiso: 403. DX-273: salir de COMPLETED (a cualquier otro estado) solo ADMIN y DENTIST, con `statusReason` (403 / 400).',
  })
  @IsOptional()
  @IsEnum(AppointmentStatus)
  status?: AppointmentStatus;

  @ApiPropertyOptional({
    minLength: STATUS_REASON_MIN,
    maxLength: STATUS_REASON_MAX,
    example: 'La cirugía no se hizo: se marcó completada por error.',
    description:
      'DX-273: motivo OBLIGATORIO para sacar la cita de COMPLETED (a SCHEDULED, CONFIRMED, CANCELLED…), de 3 a 500 caracteres tras recortar; sin él, 400. Esa salida solo la hacen ADMIN y DENTIST (RECEPTION/ASSISTANT: 403). Se guarda en `appointment_status_reversals` y queda auditado (`COMPLETED_EXIT`). El mínimo de la visita siguiente del plan se recalcula con la última cita de la visita anterior que siga completada (o queda sin mínimo); la respuesta lo dice en `completedExit.visitMinimums`. En cualquier otro cambio se ignora.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: PATIENT_FLOW_MESSAGES.completedExitReason })
  @Length(STATUS_REASON_MIN, STATUS_REASON_MAX, {
    message: PATIENT_FLOW_MESSAGES.completedExitReason,
  })
  statusReason?: string;

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
