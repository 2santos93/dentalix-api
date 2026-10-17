import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  REMINDER_REPOSITORY,
  type ReminderRepository,
} from '../../domain/ports/reminder-repository.port';
import {
  buildReminderTimeline,
  type ReminderTimelineItem,
} from '../../domain/reminder-timeline';
import { ReminderClock } from '../reminder-clock';

export const APPOINTMENT_NOT_FOUND_MESSAGE = 'Cita no encontrada';

export interface AppointmentReminders {
  /** Ajustes vigentes de la sede de la cita. */
  enabled: boolean;
  leadHours: number[];
  items: ReminderTimelineItem[];
}

/** Estado de los recordatorios de una cita para su panel (DX-026). */
@Injectable()
export class GetAppointmentRemindersUseCase {
  constructor(
    @Inject(REMINDER_REPOSITORY) private readonly repo: ReminderRepository,
    private readonly clock: ReminderClock,
  ) {}

  async execute(appointmentId: string): Promise<AppointmentReminders> {
    const snapshot = await this.repo.findAppointmentReminders(appointmentId);
    if (!snapshot) throw new NotFoundException(APPOINTMENT_NOT_FOUND_MESSAGE);
    return {
      enabled: snapshot.settings?.enabled ?? false,
      leadHours: snapshot.settings?.leadHours ?? [],
      items: buildReminderTimeline({ ...snapshot, now: this.clock.now() }),
    };
  }
}
