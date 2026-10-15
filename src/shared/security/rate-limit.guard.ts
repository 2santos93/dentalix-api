import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { tooManyRequestsException } from './too-many-requests';

/**
 * ThrottlerGuard con la respuesta 429 de Dentalix: un único `Retry-After` en
 * segundos (las cabeceras de la librería van desactivadas con
 * `setHeaders: false`) y el cuerpo en el formato de errores de la API.
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  protected throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const { res } = this.getRequestResponse(context);
    this.setResponseHeader(res, 'Retry-After', detail.timeToBlockExpire);
    return Promise.reject(tooManyRequestsException(detail.timeToBlockExpire));
  }
}
