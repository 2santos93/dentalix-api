import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import {
  WEEKLY_DIGEST_SEND_JOB,
  WEEKLY_DIGEST_SWEEP_CRON,
  WEEKLY_DIGEST_SWEEP_JOB,
  WEEKLY_DIGEST_SWEEP_SCHEDULE,
  WeeklyDigestSender,
  WeeklyDigestSweep,
} from './weekly-digest-sender';

function weekStartOf(payload: Record<string, unknown>): string {
  const { weekStart } = payload;
  if (typeof weekStart !== 'string') {
    throw new Error(`${WEEKLY_DIGEST_SEND_JOB}: payload sin weekStart`);
  }
  return weekStart;
}

/**
 * Registra en la cola de DX-085 el barrido horario del resumen semanal (un
 * ejecutor por tick, sin solaparse) y el envío de cada clínica (con la
 * clínica del trabajo en el contexto).
 */
@Injectable()
export class WeeklyDigestJobs implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly sender: WeeklyDigestSender,
    private readonly sweep: WeeklyDigestSweep,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: WEEKLY_DIGEST_SEND_JOB,
      maxAttempts: 5,
      handle: async (payload, context) => {
        if (!context.tenantId) {
          throw new Error(`${WEEKLY_DIGEST_SEND_JOB}: trabajo sin clínica`);
        }
        await this.sender.send(
          context.tenantId,
          weekStartOf(payload),
          context.signal,
        );
      },
    });
    this.registry.register({
      name: WEEKLY_DIGEST_SWEEP_JOB,
      maxAttempts: 3,
      handle: async () => {
        await this.sweep.run();
      },
    });
    this.registry.schedule({
      name: WEEKLY_DIGEST_SWEEP_SCHEDULE,
      cron: WEEKLY_DIGEST_SWEEP_CRON,
      job: WEEKLY_DIGEST_SWEEP_JOB,
      // DX-380 (OPS-046): sin solapar un tick con el anterior.
      singleton: true,
    });
  }
}
