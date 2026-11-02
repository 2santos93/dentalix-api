import { HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { LoginLockedError, loginLockedMessage } from '../domain/login-lockout';

/**
 * 429 con `Retry-After` si `err` es un bloqueo del login (DX-048) o del código
 * MFA (SEC-008, DX-021); el mismo mensaje en ambos casos. Cualquier otro
 * error, tal cual.
 */
export function lockedOr(
  err: unknown,
  res: Pick<Response, 'setHeader'>,
): unknown {
  if (!(err instanceof LoginLockedError)) return err;
  res.setHeader('Retry-After', String(err.retryAfterSeconds));
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'Too Many Requests',
      message: loginLockedMessage(err.retryAfterSeconds),
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
