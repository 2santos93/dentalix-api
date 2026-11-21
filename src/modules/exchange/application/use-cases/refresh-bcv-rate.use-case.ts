import { Inject, Injectable, Logger } from '@nestjs/common';
import { toRateColumn } from '../../../../shared/money/rate-conversion';
import { bcvSanityProblem, type BcvRateSnapshot } from '../../domain/bcv-rate';
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
  ) {}

  async execute(): Promise<BcvRefreshOutcome> {
    const raw = await this.provider.fetchLatest();
    // Con los 8 decimales de la columna: así «la misma cifra» compara igual
    // con la guardada aunque el respaldo traiga más decimales.
    const fetched: BcvRateSnapshot = {
      ...raw,
      usdVes: toRateColumn(raw.usdVes),
      eurVes: toRateColumn(raw.eurVes),
    };
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
