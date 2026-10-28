import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobQueue } from '../../jobs/application/job-queue.service';
import {
  REMINDER_REPOSITORY,
  type ReminderRepository,
} from '../domain/ports/reminder-repository.port';
import {
  reminderDueAt,
  reminderIdempotencyKey,
} from '../domain/reminder-window';
import { ReminderClock } from './reminder-clock';

export const PLAN_REMINDERS_JOB = 'reminders.plan';
export const PLAN_REMINDERS_SCHEDULE = 'reminders.plan.every-5-min';
export const SEND_REMINDER_JOB = 'reminders.send-email';

/** Payload del envío: solo ids y valores técnicos (DX-085). */
export interface SendReminderPayload {
  [key: string]: string | number;
  appointmentId: string;
  leadHours: number;
  /** Hora de inicio ISO con la que se planificó (la de la clave). */
  start: string;
}

/**
 * Barrido periódico (tarea programada de DX-085, un ejecutor por tick con N
 * workers): clínica a clínica, encola un envío por cita y antelación cuya
 * hora cae en la ventana (ver reminder-window.ts), con `runAt` en esa hora y
 * `idempotencyKey` por (cita, antelación, hora de inicio). Repetirlo, o que
 * dos ticks se solapen, no crea trabajos nuevos.
 */
@Injectable()
export class PlanReminders {
  private readonly logger = new Logger('Reminders');

  constructor(
    @Inject(REMINDER_REPOSITORY) private readonly repo: ReminderRepository,
    private readonly jobs: JobQueue,
    private readonly clock: ReminderClock,
  ) {}

  /** Devuelve cuántos envíos encoló (nuevos o ya existentes). */
  async run(): Promise<number> {
    const now = this.clock.now();
    let planned = 0;
    let failed = 0;
    for (const tenantId of await this.repo.tenantIds()) {
      try {
        planned += await this.planTenant(tenantId, now);
      } catch (error) {
        // Una clínica rota no deja sin recordatorios a las demás; el trabajo
        // falla al final para que la cola lo reintente (es idempotente).
        failed += 1;
        this.logger.warn({
          event: 'reminders.plan_failed',
          tenantId,
          error: error instanceof Error ? error.name : 'Error',
        });
      }
    }
    this.logger.log({ event: 'reminders.planned', planned, failed });
    if (failed > 0) {
      throw new Error(`Planificar recordatorios falló en ${failed} clínica(s)`);
    }
    return planned;
  }

  private async planTenant(tenantId: string, now: Date): Promise<number> {
    const candidates = await this.repo.dueCandidates(tenantId, now);
    for (const c of candidates) {
      const due = reminderDueAt(c.start, c.leadHours);
      const payload: SendReminderPayload = {
        appointmentId: c.appointmentId,
        leadHours: c.leadHours,
        start: c.start.toISOString(),
      };
      await this.jobs.enqueue(SEND_REMINDER_JOB, payload, {
        tenantId,
        // Atrasado: sin `runAt`, «ya» lo pone la BD con el reloj con que
        // reclama; `now` es el de la API y puede ir por delante (DX-355).
        ...(due.getTime() > now.getTime() ? { runAt: due } : {}),
        idempotencyKey: reminderIdempotencyKey(
          c.appointmentId,
          c.leadHours,
          c.start,
        ),
      });
    }
    return candidates.length;
  }
}
