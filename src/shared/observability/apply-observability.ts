import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppExceptionFilter } from './app-exception.filter';
import { AppLogger } from './app-logger';
import { loadLogConfig } from './log-config';
import { requestObservabilityMiddleware } from './request-observability.middleware';

/**
 * Observabilidad de la app (DX-023): logger estructurado, request id + línea
 * de acceso y filtro global de errores. La llama configureApp (main.ts y los
 * e2e) LO PRIMERO, antes de applySecurity: así el request id va también en
 * las respuestas que cortan helmet, CORS o el parser del cuerpo.
 */
export function applyObservability(
  app: INestApplication,
  logger: AppLogger = new AppLogger(
    loadLogConfig((key) => app.get(ConfigService).get<string>(key)),
  ),
): AppLogger {
  app.useLogger(logger);
  app.use(requestObservabilityMiddleware(logger));
  app.useGlobalFilters(new AppExceptionFilter(logger));
  return logger;
}
