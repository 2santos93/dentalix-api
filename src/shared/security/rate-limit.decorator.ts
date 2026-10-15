import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiTooManyRequestsResponse } from '@nestjs/swagger';
import type { RateLimitPolicy } from './rate-limit.config';

export const RATE_LIMIT_POLICIES = 'dentalix:rate-limit-policies';

/**
 * Activa en una ruta (o controlador) los límites estrictos indicados, además
 * del global, y documenta el 429 en Swagger. Ej.: `@RateLimit('auth', 'login')`.
 */
export const RateLimit = (
  ...policies: RateLimitPolicy[]
): MethodDecorator & ClassDecorator =>
  applyDecorators(
    SetMetadata(RATE_LIMIT_POLICIES, policies),
    ApiTooManyRequestsResponse({
      description:
        'Demasiadas solicitudes. La cabecera Retry-After indica los segundos de espera.',
    }),
  );
