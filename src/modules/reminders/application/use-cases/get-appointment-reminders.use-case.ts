import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type {
  MedicalHistorySubmissionOrigin,
  MedicalHistorySubmissionStatus,
} from '@prisma/client';
import {
  MEDICAL_HISTORY_SUBMISSION_REPOSITORY,
  type MedicalHistorySubmissionRepository,
} from '../../../medical-history-submissions/domain/ports/medical-history-submission-repository.port';
import { effectiveSubmissionStatus } from '../../../medical-history-submissions/domain/submission-status';
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
  /**
   * DX-290: el último enlace de anamnesis ligado a la cita (con el
   * recordatorio o por recepción) y su estado, sin respuestas; null si no
   * se envió ninguno.
   */
  anamnesis: AppointmentAnamnesisLink | null;
}

export interface AppointmentAnamnesisLink {
  origin: MedicalHistorySubmissionOrigin;
  /** Estado efectivo (un enlace sin usar cuya hora pasó, EXPIRED). */
  status: MedicalHistorySubmissionStatus;
  sentAt: Date;
  expiresAt: Date;
  submittedAt: Date | null;
}

/** Estado de los recordatorios de una cita para su panel (DX-026). */
@Injectable()
export class GetAppointmentRemindersUseCase {
  constructor(
    @Inject(REMINDER_REPOSITORY) private readonly repo: ReminderRepository,
    private readonly clock: ReminderClock,
    private readonly tenantContext: TenantContextService,
    // DX-290: opcional para los tests que construyen el caso a mano.
    @Optional()
    @Inject(MEDICAL_HISTORY_SUBMISSION_REPOSITORY)
    private readonly submissions?: MedicalHistorySubmissionRepository,
  ) {}

  async execute(appointmentId: string): Promise<AppointmentReminders> {
    const snapshot = await this.repo.findAppointmentReminders(appointmentId);
    if (!snapshot) throw new NotFoundException(APPOINTMENT_NOT_FOUND_MESSAGE);
    // SEC-045 (DX-089): una cita de una sede no permitida es 403.
    this.tenantContext.assertLocationAllowed(snapshot.locationId);
    const blocker = emailReminderBlocker(snapshot.contact);
    const patientBlocker = blocker === 'NO_EMAIL' ? null : blocker;
    const now = this.clock.now();
    const latest = this.submissions
      ? await this.submissions.latestForAppointment(appointmentId)
      : null;
    return {
      enabled: snapshot.settings?.enabled ?? false,
      leadHours: snapshot.settings?.leadHours ?? [],
      patientBlocker,
      items: buildReminderTimeline({
        ...snapshot,
        patientBlocked: patientBlocker !== null,
        now,
      }),
      anamnesis: latest
        ? {
            origin: latest.origin,
            status: effectiveSubmissionStatus(latest, now),
            sentAt: latest.createdAt,
            expiresAt: latest.expiresAt,
            submittedAt: latest.submittedAt,
          }
        : null,
    };
  }
}
