import { HttpException, HttpStatus } from '@nestjs/common';
import {
  ExchangeRateBudgetExceededError,
  ExchangeRateUnavailableError,
} from '../domain/ports/exchange-rate-provider.port';
import { humanWait } from '../../../shared/security/too-many-requests';

export const EXCHANGE_RATE_UNAVAILABLE_MESSAGE =
  'No pudimos obtener las tasas de ese día. Inténtalo de nuevo más tarde.';

interface HeaderSink {
  setHeader(name: string, value: string): unknown;
}

/**
 * SEC-054: lo que las rutas de tasas devuelven cuando no hay tasa del
 * proveedor. Nunca lleva el mensaje interno (ni nada de la respuesta del
 * proveedor):
 * - presupuesto agotado: 429 `EXCHANGE_RATE_BUDGET_EXCEEDED` con
 *   `Retry-After`;
 * - el proveedor no tiene el día, falló hace poco (caché negativa) o la
 *   clínica en MANUAL no tiene guardado un día anterior al cambio: 503
 *   `EXCHANGE_RATE_UNAVAILABLE`.
 */
export async function withProviderErrors<T>(
  res: HeaderSink,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ExchangeRateBudgetExceededError) {
      const wait = error.retryAfterSeconds;
      res.setHeader('Retry-After', String(wait));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          code: 'EXCHANGE_RATE_BUDGET_EXCEEDED',
          message:
            error.scope === 'CLINIC'
              ? `La clínica consultó demasiados días sin tasa guardada. Intenta de nuevo en ${humanWait(wait)}.`
              : `El servicio de tasas recibe demasiadas consultas. Intenta de nuevo en ${humanWait(wait)}.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (error instanceof ExchangeRateUnavailableError) {
      throw new HttpException(
        {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          error: 'Service Unavailable',
          code: 'EXCHANGE_RATE_UNAVAILABLE',
          message: EXCHANGE_RATE_UNAVAILABLE_MESSAGE,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
        { cause: error },
      );
    }
    throw error;
  }
}
