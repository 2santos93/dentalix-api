import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RecallContactChannel } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  ValidateNested,
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import {
  INPUT_NOTES_MAX,
  INPUT_REASON_MAX,
  TextMaxLength,
} from '../../../../shared/validation/input-limits';
import { CHAIR_ID_INVALID_MESSAGE } from '../../../chairs/domain/chair-rules';

/** Mismo tope que la nota de un contacto de recall (CHECK en la BD). */
const RECALL_CONTACT_NOTE_MAX = 280;

/**
 * DX-465: «Agendar» desde la lista de recall. El «Agendó» de ese recall sale
 * con este canal y esta nota en la misma transacción que la cita (en vez del
 * canal del último contacto y sin nota).
 */
export class AppointmentRecallContactDto {
  @ApiProperty({
    format: 'uuid',
    description: 'El recall desde el que se agenda',
  })
  @IsUUID('all', { message: 'recallContact.recallId debe ser un UUID.' })
  recallId!: string;

  @ApiProperty({
    enum: RecallContactChannel,
    enumName: 'RecallContactChannel',
    description: 'Por dónde se habló con el paciente',
  })
  @IsEnum(RecallContactChannel, {
    message:
      'recallContact.channel debe ser CALL, WHATSAPP_LINK, EMAIL o IN_PERSON.',
  })
  channel!: RecallContactChannel;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: RECALL_CONTACT_NOTE_MAX,
    description:
      'Nota corta del contacto (sin datos clínicos). Nunca va a la auditoría.',
  })
  @IsOptional()
  @IsString({ message: 'recallContact.note debe ser un texto.' })
  @MaxLength(RECALL_CONTACT_NOTE_MAX, {
    message: `La nota admite hasta ${RECALL_CONTACT_NOTE_MAX} caracteres.`,
  })
  note?: string | null;
}

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
      'DX-211: sillón de la cita. De esta clínica (si no, 404), de la sede de la cita y activo (si no, 400). Otra cita viva en ese sillón y franja: 409 «El sillón X ya está ocupado de HH:MM a HH:MM» (horas de la sede). Sin él, nada cambia. `null` no es «sin sillón»: 400 (DX-492-bis).',
  })
  // DX-492-bis: `null` no es «sin sillón» (eso es no mandarlo): se rechaza
  // aquí, no con un 500 al buscarlo, como en «Atender sin cita».
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID(undefined, { message: CHAIR_ID_INVALID_MESSAGE })
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
  @TextMaxLength(INPUT_REASON_MAX)
  reason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @TextMaxLength(INPUT_NOTES_MAX)
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

  @ApiPropertyOptional({
    type: AppointmentRecallContactDto,
    description:
      'DX-465: agendar desde la lista de recall. En la MISMA transacción, el «Agendó» de ese recall con este canal y esta nota (y el ciclo de intentos cerrado), aunque su tipo no cierre con el tipo de esta cita. El recall tiene que ser del paciente (si no, 400; inexistente, 404) y de una sede permitida (403). Los demás recalls que cierre la cita siguen con el canal del último contacto y sin nota.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => AppointmentRecallContactDto)
  recallContact?: AppointmentRecallContactDto;
}
