import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { AppointmentStatus, CancellationReasonCode } from '@prisma/client';
import {
  CANCEL_REASON_TEXT_MAX,
  CANCELLATION_MESSAGES,
  CANCELLATION_REASON_CODES,
  STAFF_CANCELLATION_KINDS,
  type StaffCancellationKind,
} from '../../../cancellation-policies/domain/cancellation-policy';
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
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'DX-211: cambiar el sillón (de la sede de la cita y activo; si no, 400/404) o quitarlo con null. Al cambiarlo o reagendar una cita con sillón se mira que esté libre en la franja (409 con su nombre y horas). Cambiar solo el sillón no anula el enlace de confirmación; queda auditado como movimiento.',
  })
  @IsOptional()
  @IsUUID()
  chairId?: string | null;

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
  // Solo forma y tope aquí: el mínimo lo decide el dominio DESPUÉS del rol
  // (recepción recibe 403 aunque el motivo sea corto), y fuera de una salida
  // de COMPLETED el motivo se ignora.
  @IsString({ message: PATIENT_FLOW_MESSAGES.completedExitReason })
  @MaxLength(STATUS_REASON_MAX, {
    message: PATIENT_FLOW_MESSAGES.completedExitReason,
  })
  statusReason?: string;

  @ApiPropertyOptional({
    enum: STAFF_CANCELLATION_KINDS,
    description:
      'DX-279: quién cancela, OBLIGATORIO al pasar a CANCELLED (400 sin él): STAFF_FOR_PATIENT (el paciente lo comunica al personal) o CLINIC (la clínica cancela o reprograma; nunca cuenta como tardía). El enlace público (PATIENT_LINK) no pasa por aquí. En cualquier otro cambio se ignora.',
  })
  @IsOptional()
  @IsIn(STAFF_CANCELLATION_KINDS, {
    message: CANCELLATION_MESSAGES.byKindRequired,
  })
  cancelledByKind?: StaffCancellationKind;

  @ApiPropertyOptional({
    enum: CANCELLATION_REASON_CODES,
    description:
      'DX-279: motivo del catálogo cerrado, OBLIGATORIO al pasar a CANCELLED (400 sin él). El servidor guarda la hora (UTC), los minutos de aviso y si es tardía según la política vigente de la sede de la cita; queda auditado (APPOINTMENT_CANCELLED, sin el texto libre).',
  })
  @IsOptional()
  @IsEnum(CancellationReasonCode, {
    message: CANCELLATION_MESSAGES.reasonRequired,
  })
  cancelReasonCode?: CancellationReasonCode;

  @ApiPropertyOptional({
    maxLength: CANCEL_REASON_TEXT_MAX,
    description:
      'DX-279: detalle opcional del motivo (hasta 500 caracteres; vacío = sin detalle). No pidas datos de salud. Solo al pasar a CANCELLED.',
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
      'DX-446: «Mover igualmente» en un hueco reservado (bloque RESERVED) con un tipo no permitido y sin liberar. Solo ADMIN y DENTIST (403 para el resto); 5–300 caracteres en una línea. El motivo queda en `appointment_reserved_overrides`; `audit_event` (`reservedSlotOverride`) solo guarda el id de esa fila y los bloques.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300, {
    message:
      'El motivo para agendar en un hueco reservado debe tener entre 5 y 300 caracteres.',
  })
  overrideReason?: string;
}
