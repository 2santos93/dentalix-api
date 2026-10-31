import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Dentalix API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
}

/**
 * SEC-019 (DX-083): `/docs` y `/docs-json` describen todas las rutas; en
 * producción solo se publican con `SWAGGER_ENABLED="true"` explícito.
 */
export function swaggerEnabled(
  get: (key: string) => string | undefined,
): boolean {
  return get('NODE_ENV') !== 'production' || get('SWAGGER_ENABLED') === 'true';
}
