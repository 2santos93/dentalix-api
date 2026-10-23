import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  REMINDER_REPOSITORY,
  type ReminderRepository,
} from '../../domain/ports/reminder-repository.port';
import {
  buildReminderTimeline,
  type ReminderTimelineItem,
} from '../../domain/reminder-timeline';
import {
  emailReminderBlocker,
  type ReminderContactBlocker,
} from '../../domain/reminder-eligibility';
import { ReminderClock } from '../reminder-clock';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';

/** Lo que la preferencia del paciente impide (NO_EMAIL se ve por recordatorio). */
export type PatientReminderBlocker = Exclude<
  ReminderContactBlocker,
  'NO_EMAIL'
>;

export const APPOINTMENT_NOT_FOUND_MESSAGE = 'Cita no encontrada';

export interface AppointmentReminders {
  /** Ajustes vigentes de la sede de la cita. */
  enabled: boolean;
  leadHours: number[];
  /**
   * DX-128: por qué este paciente no recibe el email automático (baja o
   * canal), o null. Con él no hay recordatorios pendientes.
   */
  patientBlocker: PatientReminderBlocker | null;
  items: ReminderTimelineItem[];
}

/** Estado de los recordatorios de una cita para su panel (DX-026). */
@Injectable()
export class GetAppointmentRemindersUseCase {
  constructor(
    @Inject(REMINDER_REPOSITORY) private readonly repo: ReminderRepository,
    private readonly clock: ReminderClock,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(appointmentId: string): Promise<AppointmentReminders> {
    const snapshot = await this.repo.findAppointmentReminders(appointmentId);
    if (!snapshot) throw new NotFoundException(APPOINTMENT_NOT_FOUND_MESSAGE);
    // SEC-045 (DX-089): una cita de una sede no permitida es 403.
    this.tenantContext.assertLocationAllowed(snapshot.locationId);
    const blocker = emailReminderBlocker(snapshot.contact);
    const patientBlocker = blocker === 'NO_EMAIL' ? null : blocker;
    return {
      enabled: snapshot.settings?.enabled ?? false,
      leadHours: snapshot.settings?.leadHours ?? [],
      patientBlocker,
      items: buildReminderTimeline({
        ...snapshot,
        patientBlocked: patientBlocker !== null,
        now: this.clock.now(),
      }),
    };
  }
}
