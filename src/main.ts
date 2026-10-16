import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './config/configure-app';
import { setupSwagger } from './config/swagger';

async function bootstrap(): Promise<void> {
  // bufferLogs: lo que Nest registre al crear la app sale ya con AppLogger.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  // Observabilidad, seguridad, límites de cuerpo, prefijo y validación: lo
  // mismo que montan los e2e (ver configure-app.ts).
  configureApp(app);
  setupSwagger(app);

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
