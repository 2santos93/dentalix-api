import { Logger, LoggerService } from '@nestjs/common';

/** Una línea por política como mucho cada 10 s. */
export const REJECTION_LOG_INTERVAL_MS = 10_000;

interface Window {
  /** Rechazos todavía sin contar en ninguna línea. */
  pending: number;
  /** Cuándo salió la última línea de esta política (ms). */
  lastLoggedAt: number;
}

/**
 * DX-555: aviso en el log de los 429 de las políticas que lo piden (hoy, la
 * marca por host: `branding-host` y `branding-miss`). Cada 429 ya sale en el
 * log de acceso con su ruta plantilla; este aviso dice además QUÉ balde se
 * agotó, que es lo que distingue «alguien enumera hosts» (miss) de «una
 * clínica recibe más renders de los previstos» (host).
 *
 * Un aluvión no debe convertirse en un aluvión de líneas: sale UNA línea por
 * política como mucho cada `REJECTION_LOG_INTERVAL_MS`, con cuántos 429 lleva
 * desde la anterior. Sin IP ni host (ni en claro ni en hash): solo la política
 * y el recuento.
 */
export class RateLimitRejectionLog {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly route: string,
    private readonly logger: Pick<LoggerService, 'warn'> = new Logger(
      'RateLimit',
    ),
    private readonly now: () => number = Date.now,
  ) {}

  record(policy: string, retryAfterSeconds: number): void {
    const at = this.now();
    const window = this.windows.get(policy) ?? {
      pending: 0,
      lastLoggedAt: Number.NEGATIVE_INFINITY,
    };
    window.pending += 1;
    this.windows.set(policy, window);
    if (at - window.lastLoggedAt < REJECTION_LOG_INTERVAL_MS) return;
    this.logger.warn({
      event: 'rate_limit.rejected',
      route: this.route,
      policy,
      rejected: window.pending,
      retryAfterSeconds,
    });
    window.pending = 0;
    window.lastLoggedAt = at;
  }
}

export const BRANDING_BY_HOST_ROUTE =
  'GET /api/v1/public/tenant/branding/by-host';

/**
 * Uno por proceso para la marca por host: el guard (`branding-host`) y
 * `BrandingMissLimitInterceptor` (`branding-miss`) escriben en él.
 */
export const brandingRejections = new RateLimitRejectionLog(
  BRANDING_BY_HOST_ROUTE,
);
