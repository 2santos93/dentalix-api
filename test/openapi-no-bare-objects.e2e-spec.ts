import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { App } from 'supertest/types';
import { findBareObjects } from '../src/architecture/openapi-bare-objects';
import { createE2eApp } from './support/create-e2e-app';

// DX-539 · el documento OpenAPI REAL no publica ningún campo como objeto vacío
// (`Record<string, never>` en el schema.d.ts de la web). Ver la guarda de fuente
// `src/architecture/no-bare-openapi-objects.spec.ts`.
describe('OpenAPI sin objetos vacíos (DX-539, e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createE2eApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('ningún DTO publica un campo sin forma', () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    expect(findBareObjects(doc)).toEqual([]);
  });

  it('CheckoutChecklistDto.balance apunta a OverdueBalanceDto y admite null', () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    const balance = (
      doc.components?.schemas?.CheckoutChecklistDto as {
        properties: Record<string, unknown>;
      }
    ).properties.balance;
    expect(JSON.stringify(balance)).toContain('OverdueBalanceDto');
  });
});
