import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobRegistry } from '../../../jobs/application/job-registry';
import {
  GetRatesForDateUseCase,
  isValidDateFormat,
} from '../use-cases/get-rates-for-date.use-case';

export const PREFETCH_RATES_JOB = 'exchange.prefetch-rates';
export const PREFETCH_RATES_SCHEDULE = 'exchange.prefetch-rates.daily';

/**
 * DX-085: precarga diaria (00:05 UTC) de los tipos de cambio del día, para
 * que la primera petición del día que convierte un abono no espere a Open
 * Exchange Rates: la encuentra en `exchange_rate_snapshots`. Reutiliza el
 * caso de uso de la petición (cache-then-fetch), así que es idempotente. La
 * petición conserva el `fetch` como respaldo ante un fallo (días históricos o
 * un día cuya precarga aún no pudo hacerse): quitarlo rompería conversiones.
 *
 * Sin EXCHANGE_APP_ID (desarrollo, CI) no hace nada. Un fallo del proveedor
 * se reintenta con backoff (5 intentos desde 5 min).
 */
@Injectable()
export class ExchangePrefetchJobs implements OnModuleInit {
  private readonly logger = new Logger('Exchange');

  constructor(
    private readonly registry: JobRegistry,
    private readonly getRates: GetRatesForDateUseCase,
    private readonly config: ConfigService,
    @Optional() private readonly now: () => Date = () => new Date(),
  ) {}

  onModuleInit(): void {
    this.registry.register<{ date?: string }>({
      name: PREFETCH_RATES_JOB,
      maxAttempts: 5,
      retryBaseMs: 5 * 60_000,
      handle: async (payload) => {
        if (!this.config.get<string>('EXCHANGE_APP_ID')) {
          this.logger.log({
            event: 'exchange.prefetch_skipped',
            reason: 'EXCHANGE_APP_ID vacío',
          });
          return;
        }
        const date = isValidDateFormat(payload.date)
          ? payload.date
          : this.now().toISOString().slice(0, 10);
        // Del proveedor, sea cual sea la fuente de cada clínica (DX-374).
        const rates = await this.getRates.providerRates(date);
        this.logger.log({
          event: 'exchange.prefetched',
          date,
          currencies: Object.keys(rates).length,
        });
      },
    });
    this.registry.schedule({
      name: PREFETCH_RATES_SCHEDULE,
      cron: '5 0 * * *',
      job: PREFETCH_RATES_JOB,
    });
  }
}
