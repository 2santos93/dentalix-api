import { ExecutionContext, Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule, ThrottlerOptions } from '@nestjs/throttler';
import {
  RATE_LIMIT_CONFIG,
  RateLimitConfig,
  RateLimitPolicy,
  loadRateLimitConfig,
} from './rate-limit.config';
import { RATE_LIMIT_POLICIES } from './rate-limit.decorator';
import {
  passwordRateLimitKey,
  staffActorRateLimitKey,
} from './rate-limit.keys';
import { RateLimitGuard } from './rate-limit.guard';

// Proveedor propio para la configuración: así un test puede sustituirla
// (`overrideProvider(RATE_LIMIT_CONFIG)`) sin tocar variables de entorno.
@Module({
  providers: [
    {
      provide: RATE_LIMIT_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): RateLimitConfig =>
        loadRateLimitConfig((key) => config.get<string>(key)),
    },
  ],
  exports: [RATE_LIMIT_CONFIG],
})
class RateLimitConfigModule {}

function throttlers(
  cfg: RateLimitConfig,
  reflector: Reflector,
): ThrottlerOptions[] {
  // Un limitador estricto solo cuenta en las rutas marcadas con @RateLimit.
  const onlyFor =
    (policy: RateLimitPolicy) =>
    (context: ExecutionContext): boolean => {
      const policies = reflector.getAllAndOverride<
        RateLimitPolicy[] | undefined
      >(RATE_LIMIT_POLICIES, [context.getHandler(), context.getClass()]);
      return !policies?.includes(policy);
    };
  const strict = (policy: RateLimitPolicy): ThrottlerOptions => ({
    name: policy,
    limit: cfg[policy].limit,
    ttl: cfg[policy].ttlMs,
    skipIf: onlyFor(policy),
  });
  // Mismo prefijo que la clave por defecto de la librería: un balde por ruta.
  const routePrefix = (context: ExecutionContext, name: string): string =>
    `${context.getClass().name}-${context.getHandler().name}-${name}`;
  const request = (context: ExecutionContext) =>
    context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();
  return [
    // `default` = límite global, por IP, en cada ruta.
    { name: 'default', limit: cfg.global.limit, ttl: cfg.global.ttlMs },
    strict('auth'),
    strict('refresh'),
    strict('login-burst'),
    strict('invitation'),
    {
      ...strict('password'),
      generateKey: (context, ip, name) =>
        passwordRateLimitKey(
          routePrefix(context, name),
          ip,
          request(context).headers.authorization,
        ),
    },
    strict('confirmation'),
    {
      ...strict('invitation-email'),
      generateKey: (context, _ip, name) =>
        staffActorRateLimitKey(
          routePrefix(context, name),
          request(context).headers.authorization,
        ),
    },
    strict('password-reset'),
    strict('public-files'),
  ];
}

/**
 * Rate limiting de toda la API (guard global). El almacenamiento es en
 * memoria del proceso: con varias instancias cada una cuenta por separado
 * (ver informe DX-001 para pasar a Redis).
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [RateLimitConfigModule],
      inject: [RATE_LIMIT_CONFIG, Reflector],
      useFactory: (cfg: RateLimitConfig, reflector: Reflector) => ({
        throttlers: throttlers(cfg, reflector),
        // Sin X-RateLimit-* ni Retry-After-<nombre>: RateLimitGuard pone un
        // único Retry-After al responder 429.
        setHeaders: false,
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class SecurityModule {}
