import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import {
  SETTLE_PROMISES_CRON,
  SETTLE_PROMISES_JOB,
  SETTLE_PROMISES_SCHEDULE,
  SettlePaymentPromises,
} from './settle-payment-promises';

/**
 * Registra en la cola de DX-085 el barrido de compromisos de pago (DX-150):
 * una tarea programada con un solo ejecutor por tick.
 */
@Injectable()
export class CollectionsJobs implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly settle: SettlePaymentPromises,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: SETTLE_PROMISES_JOB,
      maxAttempts: 3,
      handle: async () => {
        await this.settle.run();
      },
    });
    this.registry.schedule({
      name: SETTLE_PROMISES_SCHEDULE,
      cron: SETTLE_PROMISES_CRON,
      job: SETTLE_PROMISES_JOB,
    });
  }
}
