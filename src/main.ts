import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { PrismaExceptionFilter } from './shared/prisma/prisma-exception.filter';
import { applySecurity } from './shared/security/apply-security';
import { setupSwagger } from './config/swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // Proxy de confianza, helmet y CORS. Antes de Swagger para cubrir /docs.
  applySecurity(app);
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Turn Prisma unique-constraint violations (P2002) into clean 409s app-wide
  // instead of raw 500s — the safety net for duplicate-create attempts.
  app.useGlobalFilters(new PrismaExceptionFilter());

  setupSwagger(app);

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
