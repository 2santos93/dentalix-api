import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ExchangeRateBudgetExceededError,
  ExchangeRateUnavailableError,
} from '../domain/ports/exchange-rate-provider.port';
import { EXCHANGE_RATE_CLOCK } from './use-cases/manual-exchange-rates.use-cases';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Topes de las llamadas al proveedor de tasas (SEC-054); ver `.env.example`. */
export interface ProviderRatesLimits {
  /** Cuánto se recuerda que un día no lo tiene el proveedor (o falló). */
  negativeTtlMs: number;
  /** Llamadas por clínica en la ventana (fallos de caché, no peticiones). */
  clinic: { limit: number; windowMs: number };
  /**
   * Llamadas de todas las clínicas juntas en la ventana. La precarga diaria
   * no cuenta ni se corta: es la reserva del plan contratado.
   */
  global: { limit: number; windowMs: number };
}

export const PROVIDER_RATES_LIMITS = Symbol('PROVIDER_RATES_LIMITS');

// El global por defecto es ~75 % de la cuota diaria prorrateada del plan
// «Developer» de Open Exchange Rates (10.000/mes); con otro plan se ajusta.
export const DEFAULT_PROVIDER_RATES_LIMITS: ProviderRatesLimits = {
  negativeTtlMs: HOUR,
  clinic: { limit: 30, windowMs: HOUR },
  global: { limit: 250, windowMs: 24 * HOUR },
};

type EnvReader = (key: string) => string | undefined;

function positiveInt(env: EnvReader, key: string, fallback: number): number {
  const raw = env(key);
  if (raw == null || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    throw new Error(
      `Invalid env var ${key}: expected a positive integer, got "${raw}"`,
    );
  }
  return Number(raw);
}

export function loadProviderRatesLimits(env: EnvReader): ProviderRatesLimits {
  const d = DEFAULT_PROVIDER_RATES_LIMITS;
  return {
    negativeTtlMs: positiveInt(
      env,
      'EXCHANGE_NEGATIVE_CACHE_TTL_MS',
      d.negativeTtlMs,
    ),
    clinic: {
      limit: positiveInt(env, 'EXCHANGE_PROVIDER_CLINIC_LIMIT', d.clinic.limit),
      windowMs: positiveInt(
        env,
        'EXCHANGE_PROVIDER_CLINIC_WINDOW_MS',
        d.clinic.windowMs,
      ),
    },
    global: {
      limit: positiveInt(env, 'EXCHANGE_PROVIDER_GLOBAL_LIMIT', d.global.limit),
      windowMs: positiveInt(
        env,
        'EXCHANGE_PROVIDER_GLOBAL_WINDOW_MS',
        d.global.windowMs,
      ),
    },
  };
}

/**
 * Quién provoca la llamada: una clínica (la del contexto), la plataforma sin
 * clínica (un script, un job sin tenant) o la precarga diaria.
 */
export type ProviderRatesCaller =
  | { kind: 'CLINIC'; tenantId: string }
  | { kind: 'PLATFORM' }
  | { kind: 'PREFETCH' };

/** Saca una entrada de un mapa en memoria (no la BD: no es un borrado duro). */
function forget<K>(map: Map<K, unknown>, key: K): void {
  // eslint-disable-next-line no-restricted-syntax
  map.delete(key);
}

/** Por encima de esto se purgan las entradas caducadas al escribir. */
const SWEEP_THRESHOLD = 1000;

/** Marcas de tiempo de las llamadas dentro de una ventana deslizante. */
class SlidingWindow {
  private calls: number[] = [];

  constructor(
    readonly limit: number,
    private readonly windowMs: number,
  ) {}

  count(now: number): number {
    const since = now - this.windowMs;
    if (this.calls.length > 0 && this.calls[0] <= since) {
      this.calls = this.calls.filter((at) => at > since);
    }
    return this.calls.length;
  }

  isFull(now: number): boolean {
    return this.count(now) >= this.limit;
  }

  /** Segundos hasta que la llamada más antigua sale de la ventana. */
  retryAfterSeconds(now: number): number {
    const oldest = this.calls[0] ?? now;
    return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
  }

  record(now: number): void {
    this.calls.push(now);
  }
}

/**
 * La puerta de TODAS las llamadas al proveedor de tasas (SEC-054), cuya cuota
 * es una sola para la plataforma. Quien llama ya miró la caché positiva (los
 * snapshots); aquí, en este orden:
 *
 * 1. single-flight: si el día ya se está pidiendo, se espera esa respuesta
 *    (sin gastar presupuesto);
 * 2. caché negativa compartida: un día que el proveedor no tuvo o en que
 *    falló (`ExchangeRateUnavailableError`) no se pide otra vez durante
 *    `negativeTtlMs`, para ninguna clínica. La precarga no la lee (reintenta
 *    con su propio backoff) y un acierto la limpia;
 * 3. presupuesto de la clínica y global (ventanas deslizantes): superado,
 *    `ExchangeRateBudgetExceededError` sin llamar. La precarga no cuenta ni
 *    se corta: las peticiones de usuarios nunca la dejan sin cupo.
 *
 * Vive en memoria del proceso (como el rate limiting, `security.module.ts`):
 * con varias réplicas cada una tiene su caché y sus contadores, así que el
 * tope efectivo es el configurado por el número de réplicas.
 */
@Injectable()
export class ProviderRatesGate {
  private readonly logger = new Logger('Exchange');
  private readonly inFlight = new Map<
    string,
    Promise<Record<string, number>>
  >();
  private readonly unavailableUntil = new Map<string, number>();
  private readonly clinics = new Map<string, SlidingWindow>();
  private readonly global: SlidingWindow;
  private globalWarned = false;

  constructor(
    @Inject(PROVIDER_RATES_LIMITS)
    private readonly limits: ProviderRatesLimits,
    @Inject(EXCHANGE_RATE_CLOCK)
    private readonly now: () => Date,
  ) {
    this.global = new SlidingWindow(
      limits.global.limit,
      limits.global.windowMs,
    );
  }

  // `async`: un tope superado sale como promesa rechazada, no como excepción
  // síncrona. El cuerpo corre sin esperas hasta registrar la llamada en vuelo.
  async fetch(
    date: string,
    caller: ProviderRatesCaller,
    load: () => Promise<Record<string, number>>,
  ): Promise<Record<string, number>> {
    const pending = this.inFlight.get(date);
    if (pending) return pending;

    const now = this.now().getTime();
    if (caller.kind !== 'PREFETCH') {
      this.assertNotKnownUnavailable(date, now);
      this.spendBudget(caller, now);
    }

    const call = this.run(date, load);
    this.inFlight.set(date, call);
    return call;
  }

  private async run(
    date: string,
    load: () => Promise<Record<string, number>>,
  ): Promise<Record<string, number>> {
    try {
      const rates = await load();
      forget(this.unavailableUntil, date);
      return rates;
    } catch (error) {
      if (error instanceof ExchangeRateUnavailableError) {
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

  /** Comprueba los dos presupuestos y, si hay hueco en ambos, gasta uno de cada. */
  private spendBudget(
    caller: Exclude<ProviderRatesCaller, { kind: 'PREFETCH' }>,
    now: number,
  ): void {
    const clinic =
      caller.kind === 'CLINIC' ? this.clinicWindow(caller.tenantId, now) : null;
    if (clinic?.isFull(now)) {
      this.logger.warn({
        event: 'exchange.provider_budget_exhausted',
        scope: 'CLINIC',
        tenantId: caller.kind === 'CLINIC' ? caller.tenantId : undefined,
      });
      throw new ExchangeRateBudgetExceededError(
        'CLINIC',
        clinic.retryAfterSeconds(now),
      );
    }
    if (this.global.isFull(now)) {
      this.logger.warn({
        event: 'exchange.provider_budget_exhausted',
        scope: 'GLOBAL',
      });
      throw new ExchangeRateBudgetExceededError(
        'GLOBAL',
        this.global.retryAfterSeconds(now),
      );
    }
    clinic?.record(now);
    this.global.record(now);
    this.warnAtHalfGlobal(now);
  }

  private clinicWindow(tenantId: string, now: number): SlidingWindow {
    let window = this.clinics.get(tenantId);
    if (!window) {
      if (this.clinics.size >= SWEEP_THRESHOLD) {
        for (const [id, w] of this.clinics) {
          if (w.count(now) === 0) forget(this.clinics, id);
        }
      }
      window = new SlidingWindow(
        this.limits.clinic.limit,
        this.limits.clinic.windowMs,
      );
      this.clinics.set(tenantId, window);
    }
    return window;
  }

  // Aviso (una vez por subida) al pasar la mitad del presupuesto global.
  private warnAtHalfGlobal(now: number): void {
    const used = this.global.count(now);
    const half = used * 2 >= this.global.limit;
    if (half && !this.globalWarned) {
      this.logger.warn({
        event: 'exchange.provider_budget_half',
        used,
        limit: this.global.limit,
      });
    }
    this.globalWarned = half;
  }
}
