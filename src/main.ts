import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // CORS: allow the web app origin. Explicit origins via CORS_ORIGINS (comma-sep),
  // plus any subdomain of CORS_ROOT_DOMAIN (white-label tenants on their subdomains).
  const rootDomain = process.env.CORS_ROOT_DOMAIN ?? 'dentalix.local';
  const explicitOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:3001')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) return cb(null, true); // non-browser / same-origin / curl
      if (explicitOrigins.includes(origin)) return cb(null, true);
      try {
        const host = new URL(origin).hostname;
        if (host === rootDomain || host.endsWith(`.${rootDomain}`)) return cb(null, true);
      } catch {
        /* fall through to deny */
      }
      return cb(new Error(`Origin not allowed by CORS: ${origin}`), false);
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant'],
  });

  const config = new DocumentBuilder()
    .setTitle('Dentalix API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
