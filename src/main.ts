import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './config/configure-app';
import { setupSwagger } from './config/swagger';
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
  setupSwagger(app);
  // SIGTERM/SIGINT cierran la app con orden: el despachador de email
  // (DX-088) deja de barrer y espera la tanda en vuelo, y con APP_ROLE=all el
  // worker de trabajos (DX-085) espera a los trabajos en curso.
  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000);
}

// Un APP_ROLE inválido lo rechaza validateEnv al crear la app.
void (parseAppRole(process.env.APP_ROLE) === 'worker'
  ? bootstrapWorker()
  : bootstrap());
