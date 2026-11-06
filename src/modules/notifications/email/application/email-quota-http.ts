import { HttpException, HttpStatus } from '@nestjs/common';
import { EmailQuotaExceededError } from '../domain/email-quota-exceeded.error';

/**
 * El 429 en español de un tope del email (DX-088), con `retryAfterSeconds`:
 * el que ya daban las rutas del personal en su aviso temprano.
 */
export function emailQuotaTooManyRequests(
  err: EmailQuotaExceededError,
): HttpException {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      message: err.message,
      retryAfterSeconds: err.retryAfterSeconds,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/**
 * DX-149-ter: corre `work` y convierte el tope (el del aviso temprano o el
 * que salta al encolar bajo candado con `enforceQuota`) en ese 429. Lo demás
 * pasa tal cual.
 */
export async function withEmailQuotaAs429<T>(
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof EmailQuotaExceededError) {
      throw emailQuotaTooManyRequests(err);
    }
    throw err;
  }
}
