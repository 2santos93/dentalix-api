import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppLogger } from '../shared/observability/app-logger';
import { applyObservability } from '../shared/observability/apply-observability';
import { applySecurity } from '../shared/security/apply-security';
import { SecuritySettings } from '../shared/security/security-settings';
import { applyBodyLimits } from './body-limits';
import { applyAppHttpServerTimeouts } from './http-server-timeouts';

export interface ConfigureAppOptions {
  /** Logger propio (los e2e escriben en memoria); default: por entorno. */
  logger?: AppLogger;
  /** Ajustes de seguridad propios; default: los de ConfigService. */
  securitySettings?: SecuritySettings;
}

/**
 * Montaje HTTP de la app, compartido por main.ts y los e2e
 * (test/support/create-e2e-app.ts) para que no puedan desincronizarse. El
 * orden importa:
 *
 * 1. Observabilidad (DX-023): logger, X-Request-Id + log de acceso y filtro
 *    global de errores (incluye el de Prisma). Lo primero, para que el request
 *    id cubra también lo que cortan helmet, CORS o el parser del cuerpo.
 * 2. Seguridad: proxy de confianza, helmet y CORS.
 * 3. Tope de cuerpo ampliado solo para la firma de consentimientos (DX-006),
 *    antes de que Nest monte su parser en `init()`.
 * 4. Prefijo `api/v1` y ValidationPipe global.
 * 5. Plazos del servidor HTTP (keep-alive, cabeceras y petición entera) del
 *    entorno: keep-alive más largo que el del proxy de la web (DX-284) y 408
 *    a los clientes lentos (DX-431). Ver http-server-timeouts.ts.
 *
 * Swagger queda fuera: se monta después (main.ts, e2e de cabeceras).
 */
export function configureApp(
  app: INestApplication,
  options: ConfigureAppOptions = {},
): void {
  applyObservability(app, options.logger);
  applySecurity(app, options.securitySettings);
  applyBodyLimits(app);
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  applyAppHttpServerTimeouts(app);
}
