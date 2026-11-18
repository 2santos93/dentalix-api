import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobRegistry } from '../../jobs/application/job-registry';
import {
  QUOTE_FOLLOW_UP_SEND_JOB,
  QUOTE_FOLLOW_UP_SWEEP_CRON,
  QUOTE_FOLLOW_UP_SWEEP_JOB,
  QUOTE_FOLLOW_UP_SWEEP_SCHEDULE,
  QuoteFollowUpSender,
  QuoteFollowUpSweep,
} from './quote-follow-up-sender';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function payloadOf(payload: Record<string, unknown>): {
  groupId: string;
  step: number;
} {
  const { groupId, step } = payload;
  if (
    typeof groupId !== 'string' ||
    !UUID.test(groupId) ||
    typeof step !== 'number' ||
    !Number.isInteger(step) ||
    step < 1 ||
    step > 3
  ) {
    throw new Error(`${QUOTE_FOLLOW_UP_SEND_JOB}: payload inválido`);
  }
  return { groupId, step };
}

/**
 * Registra en la cola de DX-085 el barrido horario del seguimiento de
 * presupuestos (un ejecutor por tick, sin solaparse) y el aviso de cada
 * grupo y paso (con la clínica del trabajo en el contexto).
 */
@Injectable()
export class QuoteFollowUpJobs implements OnModuleInit {
  constructor(
    private readonly registry: JobRegistry,
    private readonly sender: QuoteFollowUpSender,
    private readonly sweep: QuoteFollowUpSweep,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: QUOTE_FOLLOW_UP_SEND_JOB,
      maxAttempts: 5,
      handle: async (payload, context) => {
        if (!context.tenantId) {
          throw new Error(`${QUOTE_FOLLOW_UP_SEND_JOB}: trabajo sin clínica`);
        }
        const { groupId, step } = payloadOf(payload);
        await this.sender.send(context.tenantId, groupId, step, context.signal);
      },
    });
    this.registry.register({
      name: QUOTE_FOLLOW_UP_SWEEP_JOB,
      maxAttempts: 3,
      handle: async () => {
        await this.sweep.run();
      },
    });
    this.registry.schedule({
      name: QUOTE_FOLLOW_UP_SWEEP_SCHEDULE,
      cron: QUOTE_FOLLOW_UP_SWEEP_CRON,
      job: QUOTE_FOLLOW_UP_SWEEP_JOB,
      // DX-380 (OPS-046): sin solapar un tick con el anterior.
      singleton: true,
    });
  }
}
