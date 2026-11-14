import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerLimitDetail } from '@nestjs/throttler';
import { tooManyRequestsException } from './too-many-requests';
import type { RateLimitPolicy } from './rate-limit.config';
import { RATE_LIMIT_POLICIES } from './rate-limit.decorator';
import { brandingRejections } from './rate-limit-rejection-log';

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
    // SEC-064: este guard corre antes que los interceptores, así que el 429 de
    // una ruta pública no pasaría por NoStoreHeadersInterceptor. Un 429 nunca
    // debe guardarse en una caché.
    this.setResponseHeader(res, 'Cache-Control', 'no-store');
    this.setResponseHeader(res, 'Pragma', 'no-cache');
    // DX-555: en la marca por host el único limitador del guard es
    // `branding-host` (va fuera del global): avisa en el log, agregado.
    const policies = this.reflector.getAllAndOverride<
      RateLimitPolicy[] | undefined
    >(RATE_LIMIT_POLICIES, [context.getHandler(), context.getClass()]);
    if (policies?.includes('branding-host')) {
      brandingRejections.record('branding-host', detail.timeToBlockExpire);
    }
    return Promise.reject(tooManyRequestsException(detail.timeToBlockExpire));
  }
}
