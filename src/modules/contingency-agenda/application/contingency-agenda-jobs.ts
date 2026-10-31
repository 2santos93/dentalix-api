import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import {
  CONTINGENCY_NIGHTLY_JOB,
  CONTINGENCY_SWEEP_CRON,
  CONTINGENCY_SWEEP_JOB,
  CONTINGENCY_SWEEP_SCHEDULE,
  ContingencyAgendaUseCases,
  ContingencyNightlySweep,
} from './contingency-agenda.use-cases';

function locationIdOf(payload: Record<string, unknown>): string {
  const { locationId } = payload;
  if (typeof locationId !== 'string') {
    throw new Error(`${CONTINGENCY_NIGHTLY_JOB}: payload sin locationId`);
  }
  return locationId;
}

/**
 * Registra en la cola de DX-085 el barrido horario de la agenda de
 * contingencia (un ejecutor por tick, sin solaparse) y el trabajo que genera
 * la copia nocturna de cada sede (con la clínica del trabajo en el contexto).
 */
@Injectable()
export class ContingencyAgendaJobs implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly useCases: ContingencyAgendaUseCases,
    private readonly sweep: ContingencyNightlySweep,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: CONTINGENCY_NIGHTLY_JOB,
      maxAttempts: 5,
      handle: async (payload) => {
        await this.useCases.generateNightly(locationIdOf(payload));
      },
    });
    this.registry.register({
      name: CONTINGENCY_SWEEP_JOB,
      maxAttempts: 3,
      handle: async () => {
        await this.sweep.run();
      },
    });
    this.registry.schedule({
      name: CONTINGENCY_SWEEP_SCHEDULE,
      cron: CONTINGENCY_SWEEP_CRON,
      job: CONTINGENCY_SWEEP_JOB,
      // DX-380 (OPS-046): sin solapar un tick con el anterior.
      singleton: true,
    });
  }
}
