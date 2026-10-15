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
import { loginRateLimitKey } from './rate-limit.keys';
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
  return [
    // `default` = límite global, por IP, para todas las rutas.
    { name: 'default', limit: cfg.global.limit, ttl: cfg.global.ttlMs },
    strict('auth'),
    {
      ...strict('login'),
      generateKey: (context, ip, name) =>
        loginRateLimitKey(
          `${context.getClass().name}-${context.getHandler().name}-${name}`,
          ip,
          context.switchToHttp().getRequest<{ body?: unknown }>().body,
        ),
    },
    strict('invitation'),
    strict('password'),
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
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class SecurityModule {}
