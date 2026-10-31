import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  ExchangeRateBudgetExceededError,
  ExchangeRateUnavailableError,
} from '../domain/ports/exchange-rate-provider.port';
import { EXCHANGE_RATE_CLOCK } from './use-cases/manual-exchange-rates.use-cases';
import {
  PROVIDER_RATES_LIMITS,
  type ProviderRatesLimits,
} from './provider-rates-limits';
import {
  type BudgetCaller,
  type BudgetVerdict,
  InMemoryProviderRatesBudget,
  PROVIDER_RATES_BUDGET,
  type ProviderRatesBudget,
} from './provider-rates-budget';

export {
  DEFAULT_PROVIDER_RATES_LIMITS,
  loadProviderRatesLimits,
  PROVIDER_RATES_LIMITS,
  providerRatesLimitsProblems,
  type ProviderRatesLimits,
} from './provider-rates-limits';

/**
 * Quién provoca la llamada: los que gastan del presupuesto (`BudgetCaller`:
 * una clínica, el barrido de reintentos de una clínica o la plataforma sin
 * clínica) o la precarga diaria, que no gasta.
 */
export type ProviderRatesCaller = BudgetCaller | { kind: 'PREFETCH' };

/** Saca una entrada de un mapa en memoria (no la BD: no es un borrado duro). */
function forget<K>(map: Map<K, unknown>, key: K): void {
  // eslint-disable-next-line no-restricted-syntax
  map.delete(key);
}

/** Las tasas del día si ya están guardadas; `null` si no. */
export type StoredRates = () => Promise<Record<string, number> | null>;

/** Por encima de esto se purgan las entradas caducadas al escribir. */
const SWEEP_THRESHOLD = 1000;

const sameCaller = (a: ProviderRatesCaller, b: ProviderRatesCaller) =>
  a.kind === b.kind &&
  (a.kind === 'CLINIC' || a.kind === 'SWEEP'
    ? a.tenantId === (b as { tenantId: string }).tenantId
    : true);

/**
 * La puerta de TODAS las llamadas al proveedor de tasas (SEC-054), cuya cuota
 * es una sola para la plataforma. Quien llama ya miró la caché positiva (los
 * snapshots); aquí, en este orden:
 *
 * 1. single-flight: si el día ya se está pidiendo, se espera esa respuesta
 *    (sin gastar presupuesto). Si esa llamada no entró por el presupuesto de
 *    OTRA clínica, quien esperaba lo intenta con el suyo;
 * 2. caché negativa compartida: un día que el proveedor no tuvo o en que
 *    falló (`ExchangeRateUnavailableError`) no se pide otra vez durante
 *    `negativeTtlMs`, para ninguna clínica. La precarga no la lee (reintenta
 *    con su propio backoff) y un acierto la limpia;
 * 3. presupuesto (SEC-058, `ProviderRatesBudget`): los cupos de la clínica
 *    (por hora, por día o el de clínica nueva, y el de su barrido) y el
 *    global, en contadores de la BD compartidos por todas las réplicas.
 *    Superado, `ExchangeRateBudgetExceededError` sin llamar. La precarga no
 *    cuenta ni se corta: las peticiones de usuarios nunca la dejan sin cupo.
 *
 * La caché negativa y el single-flight siguen en memoria del proceso: con
 * varias réplicas, un mismo día puede pedirse una vez en cada una (y gasta
 * presupuesto en cada una).
 */
@Injectable()
export class ProviderRatesGate {
  private readonly logger = new Logger('Exchange');
  private readonly inFlight = new Map<
    string,
    { caller: ProviderRatesCaller; call: Promise<Record<string, number>> }
  >();
  private readonly unavailableUntil = new Map<string, number>();

  constructor(
    @Inject(PROVIDER_RATES_LIMITS)
    private readonly limits: ProviderRatesLimits,
    @Inject(EXCHANGE_RATE_CLOCK)
    private readonly now: () => Date,
    @Optional()
    @Inject(PROVIDER_RATES_BUDGET)
    private readonly budget: ProviderRatesBudget = new InMemoryProviderRatesBudget(
      limits,
      now,
    ),
  ) {}

  // `async`: un tope superado sale como promesa rechazada, no como excepción
  // síncrona. El cuerpo corre sin esperas hasta registrar la llamada en vuelo
  // (el gasto del presupuesto va DENTRO de ella).
  //
  // `stored` (opcional): mira si el día ya está guardado (otra réplica o
  // petición lo guardó tras la primera lectura de quien llama). Se mira justo
  // ANTES de gastar presupuesto: un día que ya está no gasta cupo sin llamar.
  async fetch(
    date: string,
    caller: ProviderRatesCaller,
    load: () => Promise<Record<string, number>>,
    stored?: StoredRates,
  ): Promise<Record<string, number>> {
    const pending = this.inFlight.get(date);
    if (pending) {
      return pending.call.catch((error: unknown) => {
        if (
          error instanceof ExchangeRateBudgetExceededError &&
          !sameCaller(pending.caller, caller)
        ) {
          return this.fetch(date, caller, load, stored);
        }
        throw error;
      });
    }

    if (caller.kind !== 'PREFETCH') {
      this.assertNotKnownUnavailable(date, this.now().getTime());
    }
    const call = this.run(date, caller, load, stored);
    this.inFlight.set(date, { caller, call });
    return call;
  }

  private async run(
    date: string,
    caller: ProviderRatesCaller,
    load: () => Promise<Record<string, number>>,
    stored: StoredRates | undefined,
  ): Promise<Record<string, number>> {
    try {
      const already = stored ? await stored() : null;
      if (already) {
        forget(this.unavailableUntil, date);
        return already;
      }
      if (caller.kind !== 'PREFETCH') await this.spendBudget(caller);
      const rates = await load();
      forget(this.unavailableUntil, date);
      return rates;
    } catch (error) {
      if (
        error instanceof ExchangeRateUnavailableError &&
        !(error instanceof ExchangeRateBudgetExceededError)
      ) {
        this.rememberUnavailable(date);
      }
      throw error;
    } finally {
      forget(this.inFlight, date);
    }
  }

  private assertNotKnownUnavailable(date: string, now: number): void {
    const until = this.unavailableUntil.get(date);
    if (until === undefined) return;
    if (until > now) {
      throw new ExchangeRateUnavailableError(
        `El proveedor no dio las tasas del ${date} hace poco; no se vuelve a pedir hasta ${new Date(until).toISOString()}`,
      );
    }
    forget(this.unavailableUntil, date);
  }

  private rememberUnavailable(date: string): void {
    const now = this.now().getTime();
    if (this.unavailableUntil.size >= SWEEP_THRESHOLD) {
      for (const [day, until] of this.unavailableUntil) {
        if (until <= now) forget(this.unavailableUntil, day);
      }
    }
    this.unavailableUntil.set(date, now + this.limits.negativeTtlMs);
  }

  /** Gasta una llamada de todos los cupos que tocan, o lanza el 429 interno. */
  private async spendBudget(caller: BudgetCaller): Promise<void> {
    const verdict = await this.budget.spend(caller);
    const tenantId = caller.kind === 'PLATFORM' ? undefined : caller.tenantId;
    if (!verdict.spent) {
      this.logger.warn({
        event: 'exchange.provider_budget_exhausted',
        scope: verdict.scope,
        caller: caller.kind,
        quota: verdict.quota?.kind,
        tenantId,
      });
      throw new ExchangeRateBudgetExceededError(
        verdict.scope,
        verdict.retryAfterSeconds,
      );
    }
    this.warnOnThresholds(caller, tenantId, verdict);
  }

  /**
   * Los avisos salen en la llamada que cruza el umbral, una sola vez por
   * ventana aunque haya varias réplicas (el contador es el de la BD): la
   * mitad del global y cada cupo diario de una clínica que se llena (el
   * aviso de consumo anómalo; solo ids y recuentos).
   */
  private warnOnThresholds(
    caller: BudgetCaller,
    tenantId: string | undefined,
    verdict: Extract<BudgetVerdict, { spent: true }>,
  ): void {
    if (verdict.globalUsed === Math.ceil(this.limits.global.limit / 2)) {
      this.logger.warn({
        event: 'exchange.provider_budget_half',
        used: verdict.globalUsed,
        limit: this.limits.global.limit,
      });
    }
    for (const quota of verdict.filled) {
      if (quota.kind === 'HOUR') continue;
      this.logger.warn({
        event: 'exchange.provider_clinic_quota_exhausted',
        tenantId,
        caller: caller.kind,
        quota: quota.kind,
        newClinic: quota.newClinic,
        limit: quota.limit,
        windowMs: quota.windowMs,
      });
    }
  }
}
