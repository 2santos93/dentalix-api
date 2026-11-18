import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import {
  LEAD_RETENTION_REPOSITORY,
  type LeadRetentionRepository,
} from '../domain/lead-repository.port';

export const LEAD_RETENTION_JOB = 'leads.anonymize-lost';
/** Una vez al día (03:41 UTC), un ejecutor por tick, sin solaparse. */
export const LEAD_RETENTION_SCHEDULE = 'leads.anonymize-lost.daily';
export const LEAD_RETENTION_CRON = '41 3 * * *';

/**
 * DX-556 · Retención de prospectos perdidos: recorre las clínicas y anonimiza
 * los PERDIDOS con más meses de los que fija cada una. Una clínica que falla
 * no deja sin barrer a las demás; al final, falla si alguna falló (la cola
 * reintenta: es idempotente).
 */
@Injectable()
export class LeadRetention implements OnModuleInit {
  private readonly logger = new Logger('Leads');

  constructor(
    private readonly registry: JobRegistry,
    @Inject(LEAD_RETENTION_REPOSITORY)
    private readonly repo: LeadRetentionRepository,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: LEAD_RETENTION_JOB,
      maxAttempts: 3,
      handle: async () => {
        await this.run();
      },
    });
    this.registry.schedule({
      name: LEAD_RETENTION_SCHEDULE,
      cron: LEAD_RETENTION_CRON,
      job: LEAD_RETENTION_JOB,
      singleton: true,
    });
  }

  async run(): Promise<{ anonymized: number }> {
    let anonymized = 0;
    let failed = 0;
    for (const tenantId of await this.repo.tenantIds()) {
      try {
        anonymized += await this.repo.anonymizeExpired(tenantId);
      } catch (error) {
        failed += 1;
        this.logger.warn({
          event: 'leads.anonymize_failed',
          tenantId,
          error: error instanceof Error ? error.name : 'Error',
        });
      }
    }
    this.logger.log({ event: 'leads.anonymized', anonymized, failed });
    if (failed > 0) {
      throw new Error(`Anonimizar prospectos falló en ${failed} clínica(s)`);
    }
    return { anonymized };
  }
}
