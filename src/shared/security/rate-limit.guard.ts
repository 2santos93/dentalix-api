import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { tooManyRequestsException } from './too-many-requests';

/**
 * ThrottlerGuard con la respuesta 429 de Dentalix: siempre envía `Retry-After`
 * (la librería solo lo pone sin sufijo para el limitador `default`; para los
 * nombrados usa `Retry-After-<nombre>`) y el cuerpo en el formato de la API.
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
