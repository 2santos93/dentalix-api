import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { applySecurity } from './shared/security/apply-security';
import { applyObservability } from './shared/observability/apply-observability';
import { setupSwagger } from './config/swagger';
import { applyBodyLimits } from './config/body-limits';

async function bootstrap(): Promise<void> {
  // bufferLogs: lo que Nest registre al crear la app sale ya con AppLogger.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  // Logger JSON, X-Request-Id + log de acceso y filtro global de errores
  // (incluye el de Prisma: P2002 → 409, etc.). Lo primero, para que el
  // request id cubra también lo que cortan helmet/CORS (DX-023).
  applyObservability(app);
  // Proxy de confianza, helmet y CORS. Antes de Swagger para cubrir /docs.
  applySecurity(app);
  // Tope de cuerpo ampliado solo para la firma de consentimientos (DX-006).
  applyBodyLimits(app);
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  setupSwagger(app);

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
