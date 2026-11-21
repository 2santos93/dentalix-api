import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { toRateColumn } from '../../../../shared/money/rate-conversion';
import { civilDateIn } from '../../../../shared/time/civil-day';
import {
  BCV_TIME_ZONE,
  bcvOldestValueDate,
  bcvSanityProblem,
  type BcvRateSnapshot,
} from '../../domain/bcv-rate';
import { EXCHANGE_RATE_CLOCK } from './manual-exchange-rates.use-cases';
import {
  BCV_RATE_PROVIDER,
  type BcvRateProvider,
} from '../../domain/ports/bcv-rate-provider.port';
import {
  BCV_RATE_REPOSITORY,
  type BcvRateRepository,
} from '../../domain/ports/bcv-rate-repository.port';

/** Qué hizo una consulta del BCV. */
export type BcvRefreshOutcome =
  /** Fecha valor nueva: guardada. */
  | { kind: 'SAVED'; snapshot: BcvRateSnapshot }
  /** Fecha valor ya guardada con otra cifra (el BCV la corrigió): actualizada. */
  | { kind: 'UPDATED'; snapshot: BcvRateSnapshot }
  /** Fecha valor ya guardada con la misma cifra: nada que hacer. */
  | { kind: 'UNCHANGED'; snapshot: BcvRateSnapshot };

/**
 * La tasa leída no pasó la validación de cordura: no se guarda y el trabajo
 * reintenta (con su backoff, y en el siguiente tick).
 */
export class BcvRateRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`Tasa del BCV descartada: ${reason}`);
    this.name = 'BcvRateRejectedError';
  }
}

/**
 * DX-585: consulta la tasa del BCV publicada ahora y la guarda por su fecha
 * valor (idempotente):
 * - fecha valor nueva → se guarda;
 * - ya guardada con la misma cifra → nada;
 * - ya guardada con otra cifra → se corrige (los abonos que la congelaron no
 *   cambian: su tasa va en el abono, DX-375).
 *
 * Antes de guardar, la cordura (`bcvSanityProblem`): tasas > 0, EUR/USD
 * razonable y variación < 30 % frente a la última guardada hasta esa fecha
 * valor. Si no pasa, se registra un aviso y se lanza `BcvRateRejectedError`
 * (no guarda). Si el BCV y el respaldo fallan, se propaga el
 * `ExchangeRateUnavailableError` del proveedor.
 */
@Injectable()
export class RefreshBcvRateUseCase {
  private readonly logger = new Logger('Exchange');

  constructor(
    @Inject(BCV_RATE_PROVIDER) private readonly provider: BcvRateProvider,
    @Inject(BCV_RATE_REPOSITORY) private readonly repo: BcvRateRepository,
    @Optional()
    @Inject(EXCHANGE_RATE_CLOCK)
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(): Promise<BcvRefreshOutcome> {
    const fetched = normalized(await this.provider.fetchLatest());
    await this.coldStart(fetched);
    return this.save(fetched);
  }

  /**
   * DX-586, arranque en frío: el BCV publica por la tarde la tasa del día
   * hábil siguiente (fecha valor futura). Si es lo primero que se guarda (o
   * la última guardada es demasiado vieja), hoy no tendría tasa hasta mañana.
   * En ese caso se guarda también la vigente de hoy desde el respaldo
   * (dolarapi, `fechaActualizacion` ≤ hoy en Caracas), con origen FALLBACK.
   * Nunca falla la consulta: si el respaldo no la da (o no pasa la cordura),
   * se deja un aviso y sigue.
   */
  private async coldStart(fetched: BcvRateSnapshot): Promise<void> {
    const today = civilDateIn(this.now(), BCV_TIME_ZONE);
    if (fetched.valueDate <= today || !this.provider.fetchFallback) return;
    if (await this.repo.inForce(today, bcvOldestValueDate(today))) return;
    try {
      const current = normalized(await this.provider.fetchFallback());
      if (current.valueDate > today) {
        this.logger.warn({
          event: 'exchange.bcv_cold_start_skipped',
          reason: 'el respaldo también trae una fecha valor futura',
          valueDate: current.valueDate,
        });
        return;
      }
      const outcome = await this.save({ ...current, origin: 'FALLBACK' });
      this.logger.log({
        event: 'exchange.bcv_cold_start',
        kind: outcome.kind,
        valueDate: current.valueDate,
      });
    } catch (error) {
      this.logger.warn({
        event: 'exchange.bcv_cold_start_failed',
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  private async save(fetched: BcvRateSnapshot): Promise<BcvRefreshOutcome> {
    const previous = await this.repo.latestUpTo(fetched.valueDate);
    if (
      previous?.valueDate === fetched.valueDate &&
      previous.usdVes === fetched.usdVes &&
      previous.eurVes === fetched.eurVes
    ) {
      return { kind: 'UNCHANGED', snapshot: previous };
    }
    const problem = bcvSanityProblem(fetched, previous);
    if (problem) {
      this.logger.warn({
        event: 'exchange.bcv_rate_rejected',
        reason: problem,
        origin: fetched.origin,
        valueDate: fetched.valueDate,
        usdVes: fetched.usdVes,
        eurVes: fetched.eurVes,
        previousValueDate: previous?.valueDate ?? null,
        previousUsdVes: previous?.usdVes ?? null,
        previousEurVes: previous?.eurVes ?? null,
      });
      throw new BcvRateRejectedError(problem);
    }
    await this.repo.upsert(fetched);
    const kind =
      previous?.valueDate === fetched.valueDate ? 'UPDATED' : 'SAVED';
    this.logger.log({
      event: 'exchange.bcv_rate_saved',
      kind,
      origin: fetched.origin,
      valueDate: fetched.valueDate,
      usdVes: fetched.usdVes,
      eurVes: fetched.eurVes,
    });
    return { kind, snapshot: fetched };
  }
}

/**
 * Con los 8 decimales de la columna: así «la misma cifra» compara igual con
 * la guardada aunque el respaldo traiga más decimales.
 */
function normalized(raw: BcvRateSnapshot): BcvRateSnapshot {
  return {
    ...raw,
    usdVes: toRateColumn(raw.usdVes),
    eurVes: toRateColumn(raw.eurVes),
  };
}
