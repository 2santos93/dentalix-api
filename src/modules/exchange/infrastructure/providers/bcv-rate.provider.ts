import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { civilDateIn } from '../../../../shared/time/civil-day';
import { BCV_TIME_ZONE, type BcvRateSnapshot } from '../../domain/bcv-rate';
import type { BcvRateProvider } from '../../domain/ports/bcv-rate-provider.port';
import { ExchangeRateUnavailableError } from '../../domain/ports/exchange-rate-provider.port';
import { EXCHANGE_RATE_CLOCK } from '../../application/use-cases/manual-exchange-rates.use-cases';
import { getText } from './bcv-http';
import { BcvPageFormatError, parseBcvPage } from './bcv-page-parser';

export const DEFAULT_BCV_BASE_URL = 'https://www.bcv.org.ve';
export const DEFAULT_BCV_FALLBACK_BASE_URL = 'https://ve.dolarapi.com';

/** Una cotización del respaldo: `promedio` y su `fechaActualizacion`. */
interface FallbackQuote {
  promedio: number;
  fechaActualizacion: string;
}

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * La cotización «oficial» de una respuesta del respaldo: un objeto (la de
 * `/v1/dolares/oficial`) o una lista con varias fuentes (`/v1/euros`).
 */
function officialQuote(payload: unknown): FallbackQuote | null {
  const candidates = Array.isArray(payload) ? payload : [payload];
  const quote = candidates.find(
    (c): c is Record<string, unknown> =>
      typeof c === 'object' &&
      c !== null &&
      (!('fuente' in c) || (c as { fuente: unknown }).fuente === 'oficial'),
  );
  if (!quote) return null;
  const { promedio, fechaActualizacion } = quote;
  if (
    typeof promedio !== 'number' ||
    !Number.isFinite(promedio) ||
    promedio <= 0 ||
    typeof fechaActualizacion !== 'string' ||
    Number.isNaN(Date.parse(fechaActualizacion))
  ) {
    return null;
  }
  return { promedio, fechaActualizacion };
}

/** Lo que se registra de un fallo: el tipo, nunca un cuerpo ni un mensaje ajeno. */
function failureReason(error: unknown): string {
  if (error instanceof BcvPageFormatError) return error.reason;
  if (error instanceof ExchangeRateUnavailableError) return error.message;
  return error instanceof Error ? error.name : typeof error;
}

/**
 * DX-585: la tasa oficial del BCV.
 *
 * 1. La portada de `BCV_BASE_URL` (https://www.bcv.org.ve): bloques `#dolar`
 *    y `#euro` y la «Fecha Valor» (ver `parseBcvPage`).
 * 2. Si no contesta o no se entiende, el respaldo `BCV_FALLBACK_BASE_URL`
 *    (https://ve.dolarapi.com): `/v1/dolares/oficial` y `/v1/euros`, campo
 *    `promedio`; la fecha valor es el día de Caracas de `fechaActualizacion`
 *    (tiene que ser el mismo en las dos monedas).
 * 3. Si los dos fallan, `ExchangeRateUnavailableError`: sin tasa, nunca una
 *    inventada.
 *
 * Cada llamada: 10 s como mucho y errores sin el cuerpo (SEC-054). Sin
 * presupuestos: solo la llama el trabajo programado (`exchange.bcv-refresh`),
 * nunca una petición.
 */
@Injectable()
export class BcvOfficialRateProvider implements BcvRateProvider {
  private readonly logger = new Logger('Exchange');

  constructor(
    private readonly config: ConfigService,
    @Optional()
    @Inject(EXCHANGE_RATE_CLOCK)
    private readonly now: () => Date = () => new Date(),
  ) {}

  async fetchLatest(): Promise<BcvRateSnapshot> {
    try {
      return await this.official();
    } catch (error) {
      this.logger.warn({
        event: 'exchange.bcv_official_failed',
        reason: failureReason(error),
      });
    }
    try {
      return await this.fallback();
    } catch (error) {
      const reason = failureReason(error);
      this.logger.warn({ event: 'exchange.bcv_fallback_failed', reason });
      throw new ExchangeRateUnavailableError(
        `Sin tasa del BCV: ni la página oficial ni el respaldo la dieron (${reason})`,
      );
    }
  }

  /** DX-586: solo el respaldo (arranque en frío, ver el puerto). */
  async fetchFallback(): Promise<BcvRateSnapshot> {
    try {
      return await this.fallback();
    } catch (error) {
      const reason = failureReason(error);
      this.logger.warn({ event: 'exchange.bcv_fallback_failed', reason });
      throw new ExchangeRateUnavailableError(
        `Sin tasa del respaldo del BCV (${reason})`,
      );
    }
  }

  private async official(): Promise<BcvRateSnapshot> {
    const base = trimSlash(
      this.config.get<string>('BCV_BASE_URL') || DEFAULT_BCV_BASE_URL,
    );
    const html = await getText(`${base}/`, 'La página del BCV');
    const fetchedAt = this.now();
    return { ...parseBcvPage(html), fetchedAt, origin: 'BCV' };
  }

  private async fallback(): Promise<BcvRateSnapshot> {
    const base = trimSlash(
      this.config.get<string>('BCV_FALLBACK_BASE_URL') ||
        DEFAULT_BCV_FALLBACK_BASE_URL,
    );
    const [usdText, eurText] = await Promise.all([
      getText(`${base}/v1/dolares/oficial`, 'El respaldo del BCV (USD)'),
      getText(`${base}/v1/euros`, 'El respaldo del BCV (EUR)'),
    ]);
    const usd = officialQuote(parseJson(usdText));
    const eur = officialQuote(parseJson(eurText));
    if (!usd || !eur) {
      throw new ExchangeRateUnavailableError(
        'El respaldo del BCV no tiene la forma esperada',
      );
    }
    const usdDate = civilDateIn(
      new Date(usd.fechaActualizacion),
      BCV_TIME_ZONE,
    );
    const eurDate = civilDateIn(
      new Date(eur.fechaActualizacion),
      BCV_TIME_ZONE,
    );
    if (usdDate !== eurDate) {
      throw new ExchangeRateUnavailableError(
        'El respaldo del BCV trae USD y EUR de días distintos',
      );
    }
    return {
      usdVes: usd.promedio,
      eurVes: eur.promedio,
      valueDate: usdDate,
      fetchedAt: this.now(),
      origin: 'FALLBACK',
    };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
