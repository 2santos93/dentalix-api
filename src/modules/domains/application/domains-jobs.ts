import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import {
  DomainRecheckSweep,
  RECHECK_DOMAIN_JOB,
  RECHECK_SWEEP_JOB,
  RECHECK_SWEEP_SCHEDULE,
  RecheckDomain,
} from './domain-recheck';

/**
 * Registra en la cola de DX-085 la re-verificación periódica de los dominios
 * VERIFIED (SEC-009): un barrido por hora (un ejecutor por tick) que encola
 * una comprobación por dominio, como los recordatorios de DX-026.
 */
@Injectable()
export class DomainsJobs implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly sweep: DomainRecheckSweep,
    private readonly recheck: RecheckDomain,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: RECHECK_DOMAIN_JOB,
      // Reintentos solo si el DNS no responde; si el último tampoco obtiene
      // respuesta, la ronda no cuenta.
      maxAttempts: 3,
      retryBaseMs: 60_000,
      handle: (payload, context) => this.recheck.handle(payload, context),
    });
    this.registry.register({
      name: RECHECK_SWEEP_JOB,
      maxAttempts: 3,
      handle: async () => {
        await this.sweep.run();
      },
    });
    this.registry.schedule({
      name: RECHECK_SWEEP_SCHEDULE,
      cron: '29 * * * *',
      job: RECHECK_SWEEP_JOB,
    });
  }
}
