import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import {
  EXPIRE_SLOT_OFFERS_CRON,
  EXPIRE_SLOT_OFFERS_JOB,
  EXPIRE_SLOT_OFFERS_SCHEDULE,
  ExpireSlotOffers,
} from './expire-slot-offers';

/**
 * Registra en la cola de DX-085 el barrido de ofertas de hueco caducadas
 * (DX-435): una tarea programada con un solo ejecutor por tick.
 */
@Injectable()
export class WaitlistJobs implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly expire: ExpireSlotOffers,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: EXPIRE_SLOT_OFFERS_JOB,
      maxAttempts: 3,
      handle: async () => {
        await this.expire.run();
      },
    });
    this.registry.schedule({
      name: EXPIRE_SLOT_OFFERS_SCHEDULE,
      cron: EXPIRE_SLOT_OFFERS_CRON,
      job: EXPIRE_SLOT_OFFERS_JOB,
      // DX-380 (OPS-046): sin solapar un tick con el anterior.
      singleton: true,
    });
  }
}
