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
      'NO_EMAIL sin email · CANCELLED/COMPLETED/NO_SHOW estado de la cita · RESCHEDULED a otra hora · DELETED retirada · DISABLED la sede los desactivó · TOO_LATE fuera de plazo (la cita ya había empezado o su hora pasó hace más de 1 h)',
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

  @ApiProperty({ type: [AppointmentReminderItemDto] })
  items!: AppointmentReminderItemDto[];
}
