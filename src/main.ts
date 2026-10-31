import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './config/configure-app';
import { installGracefulShutdown } from './config/graceful-shutdown';
import { loadShutdownConfig } from './config/shutdown-config';
import { setupSwagger, swaggerEnabled } from './config/swagger';
import { parseAppRole } from './modules/jobs/infrastructure/jobs-config';
import { AppLogger } from './shared/observability/app-logger';
import { loadLogConfig } from './shared/observability/log-config';

/**
 * Proceso WORKER (DX-085, `APP_ROLE=worker`): la misma imagen y el mismo
 * AppModule, pero sin servidor HTTP. El JobWorker arranca en
 * onApplicationBootstrap y, con SIGTERM/SIGINT (enableShutdownHooks), deja de
 * reclamar y espera a los trabajos en curso antes de salir.
 */
async function bootstrapWorker(): Promise<void> {
  // createApplicationContext ya inicializa (y arranca el worker); los logs
  // quedan en búfer hasta useLogger.
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(
    new AppLogger(
      loadLogConfig((key) => app.get(ConfigService).get<string>(key)),
    ),
  );
  app.enableShutdownHooks();
}

async function bootstrap(): Promise<void> {
  // bufferLogs: lo que Nest registre al crear la app sale ya con AppLogger.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  // Observabilidad, seguridad, límites de cuerpo, prefijo y validación: lo
  // mismo que montan los e2e (ver configure-app.ts).
  configureApp(app);
  const config = app.get(ConfigService);
  if (swaggerEnabled((key) => config.get<string>(key))) setupSwagger(app);
  // SIGTERM/SIGINT (DX-083): readiness 503, drenado, cierre del servidor HTTP
  // con las peticiones en vuelo terminadas y, después, app.close(): el
  // despachador de email (DX-088) espera la tanda en vuelo, con APP_ROLE=all
  // el worker (DX-085) espera a sus trabajos, y Prisma se desconecta. Sin
  // enableShutdownHooks: cerraría la base antes que el HTTP.
  installGracefulShutdown(
    app,
    loadShutdownConfig((key) => config.get<string>(key)),
  );

  await app.listen(process.env.PORT ?? 3000);
}

// Un APP_ROLE inválido lo rechaza validateEnv al crear la app.
void (parseAppRole(process.env.APP_ROLE) === 'worker'
  ? bootstrapWorker()
  : bootstrap());
