import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import {
  PLAN_REMINDERS_JOB,
  PLAN_REMINDERS_SCHEDULE,
  PlanReminders,
  SEND_REMINDER_JOB,
} from './plan-reminders';
import { SendAppointmentReminder } from './send-appointment-reminder';

/**
 * Registra en la cola de DX-085 el barrido de recordatorios (cada 5 min, un
 * ejecutor por tick) y el envío de cada recordatorio.
 */
@Injectable()
export class RemindersJobs implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly plan: PlanReminders,
    private readonly send: SendAppointmentReminder,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: SEND_REMINDER_JOB,
      maxAttempts: 5,
      handle: (payload, context) => this.send.handle(payload, context),
    });
    this.registry.register({
      name: PLAN_REMINDERS_JOB,
      maxAttempts: 3,
      handle: async () => {
        await this.plan.run();
      },
    });
    this.registry.schedule({
      name: PLAN_REMINDERS_SCHEDULE,
      cron: '*/5 * * * *',
      job: PLAN_REMINDERS_JOB,
      // DX-380 (OPS-046): sin solapar un tick con el anterior.
      singleton: true,
    });
  }
}
