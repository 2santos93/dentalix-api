import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobRegistry } from '../../../jobs/application/job-registry';
import { JobQueue } from '../../../jobs/application/job-queue.service';
import { JOBS_CONFIG } from '../../../jobs/infrastructure/jobs-config';
import type { JobsConfig } from '../../../jobs/infrastructure/jobs-config';
import { civilDateIn } from '../../../../shared/time/civil-day';
import { BCV_TIME_ZONE } from '../../domain/bcv-rate';
import {
  BCV_RATE_REPOSITORY,
  type BcvRateRepository,
} from '../../domain/ports/bcv-rate-repository.port';
import { RefreshBcvRateUseCase } from '../use-cases/refresh-bcv-rate.use-case';
import { EXCHANGE_RATE_CLOCK } from '../use-cases/manual-exchange-rates.use-cases';

export const BCV_REFRESH_JOB = 'exchange.bcv-refresh';

/**
 * DX-585: cuándo se consulta el BCV. Suele publicar por la tarde la tasa del
 * día hábil siguiente: de lunes a viernes, cada hora de 13:00 a 20:00 de
 * Caracas (UTC−4 todo el año). El cron de la cola va en UTC: 17:00–23:00 de
 * lunes a viernes y 00:00 de martes a sábado (las 20:00 del día anterior).
 * Los feriados no se modelan: una consulta de más devuelve la misma fecha
 * valor y no hace nada.
 */
export const BCV_REFRESH_SCHEDULES = [
  { name: 'exchange.bcv-refresh.afternoon', cron: '0 17-23 * * 1-5' },
  { name: 'exchange.bcv-refresh.evening', cron: '0 0 * * 2-6' },
] as const;

/**
 * DX-585: el trabajo que guarda la tasa del BCV (`RefreshBcvRateUseCase`):
 * idempotente (upsert por fecha valor; si ya está con la misma cifra, nada).
 * Un fallo (el BCV y el respaldo caídos, o una tasa que no pasa la cordura)
 * se reintenta con backoff: 3 intentos desde 10 min; y el tick siguiente
 * vuelve a probar. Sin presupuestos SEC-054: no es Open Exchange Rates.
 *
 * Al arrancar un worker, si la última tasa guardada no se consultó hoy (día
 * de Caracas), se encola una consulta: un despliegue a media tarde no espera
 * al siguiente tick.
 *
 * Nunca toca la red real en los tests: con NODE_ENV=test y sin BCV_BASE_URL
 * explícita (la de un servidor falso), el trabajo no hace nada.
 */
@Injectable()
export class BcvRateJobs implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger('Exchange');

  constructor(
    private readonly registry: JobRegistry,
    private readonly queue: JobQueue,
    private readonly refresh: RefreshBcvRateUseCase,
    private readonly config: ConfigService,
    @Inject(JOBS_CONFIG) private readonly jobsConfig: JobsConfig,
    @Inject(BCV_RATE_REPOSITORY) private readonly repo: BcvRateRepository,
    @Optional()
    @Inject(EXCHANGE_RATE_CLOCK)
    private readonly now: () => Date = () => new Date(),
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: BCV_REFRESH_JOB,
      maxAttempts: 3,
      retryBaseMs: 10 * 60_000,
      handle: async () => {
        if (!this.enabled()) {
          this.logger.log({
            event: 'exchange.bcv_refresh_skipped',
            reason: 'tests sin BCV_BASE_URL',
          });
          return;
        }
        await this.refresh.execute();
      },
    });
    for (const schedule of BCV_REFRESH_SCHEDULES) {
      this.registry.schedule({
        ...schedule,
        job: BCV_REFRESH_JOB,
        singleton: true,
      });
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.jobsConfig.workerEnabled || !this.enabled()) return;
    try {
      await this.enqueueIfMissingToday();
    } catch (error) {
      // El arranque no se cae por esto: el tick siguiente la consulta.
      this.logger.warn({
        event: 'exchange.bcv_startup_enqueue_failed',
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  /** Encola una consulta si la última tasa guardada no es de hoy (Caracas). */
  async enqueueIfMissingToday(): Promise<boolean> {
    const today = civilDateIn(this.now(), BCV_TIME_ZONE);
    const latest = await this.repo.latest();
    if (latest && civilDateIn(latest.fetchedAt, BCV_TIME_ZONE) >= today) {
      return false;
    }
    await this.queue.enqueue(
      BCV_REFRESH_JOB,
      {},
      { idempotencyKey: `bcv-startup:${today}` },
    );
    return true;
  }

  private enabled(): boolean {
    return (
      this.config.get<string>('NODE_ENV') !== 'test' ||
      !!this.config.get<string>('BCV_BASE_URL')
    );
  }
}
