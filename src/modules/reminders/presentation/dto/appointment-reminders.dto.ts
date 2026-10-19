import { ApiProperty } from '@nestjs/swagger';
import { AppointmentReminderSkipReason } from '@prisma/client';

const STATES = ['SENT', 'SKIPPED', 'SENDING', 'PENDING', 'MISSED'] as const;
const DELIVERIES = ['PENDING', 'SENT', 'FAILED'] as const;

export class AppointmentReminderItemDto {
  @ApiProperty({ example: 48 })
  leadHours!: number;

  @ApiProperty({
    format: 'date-time',
    description: 'Hora de inicio de la cita para la que es este recordatorio',
  })
  appointmentStart!: Date;

  @ApiProperty({
    format: 'date-time',
    description: 'Inicio menos la antelación',
  })
  dueAt!: Date;

  @ApiProperty({
    enum: STATES,
    enumName: 'AppointmentReminderState',
    description:
      'SENT: dejado en el outbox de email (sentAt). SKIPPED: omitido (skipReason). SENDING: entregándose. PENDING: saldrá en dueAt. MISSED: su hora pasó sin enviarse (la cita se agendó después).',
  })
  state!: (typeof STATES)[number];

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  sentAt!: Date | null;

  @ApiProperty({
    enum: AppointmentReminderSkipReason,
    enumName: 'AppointmentReminderSkipReason',
    nullable: true,
    description:
      'NO_EMAIL sin email · OPTED_OUT el paciente se dio de baja · CHANNEL_NONE / CHANNEL_WHATSAPP su canal no es el email (DX-128) · CANCELLED/COMPLETED/NO_SHOW estado de la cita · RESCHEDULED a otra hora · DELETED retirada · DISABLED la sede los desactivó · TOO_LATE fuera de plazo (la cita ya había empezado o su hora pasó hace más de 1 h)',
  })
  skipReason!: AppointmentReminderSkipReason | null;

  @ApiProperty({
    enum: DELIVERIES,
    enumName: 'ReminderEmailDelivery',
    nullable: true,
    description: 'Entrega del email por el proveedor (solo si se envió)',
  })
  emailDelivery!: (typeof DELIVERIES)[number] | null;

  @ApiProperty({
    description:
      'DX-203: salió al email del responsable del paciente (un menor o un paciente sin email): «Recordatorio enviado al responsable».',
  })
  sentToResponsible!: boolean;

  @ApiProperty({
    description:
      'false = de una hora de inicio anterior (la cita se reprogramó)',
  })
  current!: boolean;
}

/** Estado de los recordatorios de una cita (DX-026). */
export class AppointmentRemindersDto {
  @ApiProperty({ description: 'Recordatorios activos en la sede de la cita' })
  enabled!: boolean;

  @ApiProperty({ type: [Number], example: [48, 2] })
  leadHours!: number[];

  @ApiProperty({
    enum: ['OPTED_OUT', 'CHANNEL_NONE', 'CHANNEL_WHATSAPP'],
    enumName: 'PatientReminderBlocker',
    nullable: true,
    description:
      'DX-128: por qué el paciente no recibe el email automático (se dio de baja, o su canal es NONE o WHATSAPP). Con él no hay recordatorios pendientes.',
  })
  patientBlocker!: 'OPTED_OUT' | 'CHANNEL_NONE' | 'CHANNEL_WHATSAPP' | null;

  @ApiProperty({ type: [AppointmentReminderItemDto] })
  items!: AppointmentReminderItemDto[];
}
