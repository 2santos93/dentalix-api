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
  brandingHostRateLimitKey,
  passwordRateLimitKey,
  publicTokenRateLimitKey,
  staffActorRateLimitKey,
} from './rate-limit.keys';
import { RateLimitGuard } from './rate-limit.guard';
import { normalizeBrandingHost } from '../../modules/public-branding/application/branding-host';
import {
  PATIENT_ACCESS_COOKIE,
  readCookie,
} from '../../modules/patient-access/domain/patient-access-session';

// Proveedor propio para la configuración: así un test puede sustituirla
// (`overrideProvider(RATE_LIMIT_CONFIG)`) sin tocar variables de entorno. Lo
// importa también el módulo de la marca para `BrandingMissLimitInterceptor`
// (DX-555): es el mismo módulo, así que la sustitución vale para los dos.
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
export class RateLimitConfigModule {}

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
      params?: Record<string, string | undefined>;
      query?: Record<string, unknown>;
    }>();
  return [
    // `default` = límite global, por IP, en cada ruta.
    { name: 'default', limit: cfg.global.limit, ttl: cfg.global.ttlMs },
    strict('auth'),
    strict('subdomain-check'),
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
    // DX-099: el cuestionario público, por IP y por token.
    strict('anamnesis'),
    {
      ...strict('anamnesis-token'),
      generateKey: (context, _ip, name) =>
        publicTokenRateLimitKey(
          routePrefix(context, name),
          request(context).params?.token,
        ),
    },
    // DX-243: la firma a distancia pública, por IP y por token.
    strict('signature'),
    {
      ...strict('signature-token'),
      generateKey: (context, _ip, name) =>
        publicTokenRateLimitKey(
          routePrefix(context, name),
          request(context).params?.token,
        ),
    },
    // DX-435: la oferta de hueco pública, por IP y por token.
    strict('slot-offer'),
    {
      ...strict('slot-token'),
      generateKey: (context, _ip, name) =>
        publicTokenRateLimitKey(
          routePrefix(context, name),
          request(context).params?.token,
        ),
    },
    // DX-443: la copia pública del PDF firmado, por IP y por token.
    strict('copy-link'),
    {
      ...strict('copy-token'),
      generateKey: (context, _ip, name) =>
        publicTokenRateLimitKey(
          routePrefix(context, name),
          request(context).params?.token,
        ),
    },
    // DX-569: el enlace de pago público, por IP y por token.
    strict('payment-link'),
    {
      ...strict('payment-link-token'),
      generateKey: (context, _ip, name) =>
        publicTokenRateLimitKey(
          routePrefix(context, name),
          request(context).params?.token,
        ),
    },
    // DX-588: el tablero de la pantalla de sala de espera, por IP y por token.
    strict('waiting-room'),
    {
      ...strict('waiting-room-token'),
      generateKey: (context, _ip, name) =>
        publicTokenRateLimitKey(
          routePrefix(context, name),
          request(context).params?.token,
        ),
    },
    // DX-101: el portal del paciente (verificar la fecha y sus datos), por IP
    // y, la verificación, por token.
    strict('patient-access'),
    {
      ...strict('patient-access-token'),
      generateKey: (context, _ip, name) =>
        publicTokenRateLimitKey(
          routePrefix(context, name),
          request(context).params?.token,
        ),
    },
    {
      // DX-101-bis: aceptar un presupuesto desde el portal, por SESIÓN (el
      // valor de la cookie del portal, hasheado; sin IP). Sin cookie, un
      // balde común: esas peticiones acaban en 401 en el guard.
      ...strict('patient-access-accept'),
      generateKey: (context, _ip, name) =>
        publicTokenRateLimitKey(
          routePrefix(context, name),
          readCookie(request(context).headers.cookie, PATIENT_ACCESS_COOKIE),
        ),
    },
    // DX-467: verificar una receta por el código de su QR, por IP.
    strict('prescription-verify'),
    // DX-016: la página pública de reserva online, por IP (lecturas y escrituras).
    strict('online-booking'),
    strict('online-booking-write'),
    {
      ...strict('direct-upload'),
      generateKey: (context, _ip, name) =>
        staffActorRateLimitKey(
          routePrefix(context, name),
          request(context).headers.authorization,
        ),
    },
    {
      // SEC-046: un balde por clínica + usuario para TODAS las rutas que leen
      // un fichero de importación (el prefijo es la política, no la ruta).
      ...strict('patient-import'),
      generateKey: (context, _ip, name) =>
        staffActorRateLimitKey(name, request(context).headers.authorization),
    },
    {
      // SEC-054: leer tasas, un balde por clínica + usuario para las dos rutas.
      ...strict('exchange-rates'),
      generateKey: (context, _ip, name) =>
        staffActorRateLimitKey(name, request(context).headers.authorization),
    },
    {
      // DX-584: la tasa del menú, un balde por clínica + usuario (suave:
      // la web la refresca cada 5 min, al volver el foco y por evento).
      ...strict('exchange-header'),
      generateKey: (context, _ip, name) =>
        staffActorRateLimitKey(name, request(context).headers.authorization),
    },
    {
      // DX-555: la marca por host del render de servidor, por IP + host
      // normalizado (la ruta va FUERA del global con @SkipThrottle). Sus
      // FALLOS, por IP, los cuenta BrandingMissLimitInterceptor.
      ...strict('branding-host'),
      generateKey: (context, ip, name) =>
        brandingHostRateLimitKey(
          routePrefix(context, name),
          ip,
          normalizeBrandingHost(request(context).query?.host),
        ),
    },
    {
      // DX-224: «¿Quién llama?», un balde por clínica + usuario.
      ...strict('caller-lookup'),
      generateKey: (context, _ip, name) =>
        staffActorRateLimitKey(name, request(context).headers.authorization),
    },
    {
      // DX-562: citas en serie, un balde por clínica + usuario para TODAS
      // sus rutas (el prefijo es la política, no la ruta).
      ...strict('appointment-series'),
      generateKey: (context, _ip, name) =>
        staffActorRateLimitKey(name, request(context).headers.authorization),
    },
    {
      // DX-465: lote de intentos de recall, un balde por clínica + usuario.
      ...strict('recall-batch'),
      generateKey: (context, _ip, name) =>
        staffActorRateLimitKey(name, request(context).headers.authorization),
    },
    {
      // DX-571: leer un extracto del banco, un balde por clínica + usuario
      // para sus tres rutas (inspección, vista previa y confirmación).
      ...strict('bank-statement'),
      generateKey: (context, _ip, name) =>
        staffActorRateLimitKey(name, request(context).headers.authorization),
    },
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
