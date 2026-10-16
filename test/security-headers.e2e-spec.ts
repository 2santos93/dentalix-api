import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { promises as fs } from 'fs';
import * as path from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { applySecurity } from '../src/shared/security/apply-security';
import { setupSwagger } from '../src/config/swagger';

// Construye la app igual que main.ts (applySecurity + Swagger) para verificar
// las cabeceras HTTP de seguridad tal como salen en producción.
describe('Cabeceras de seguridad (e2e)', () => {
  let app: INestApplication<App>;
  const storageRoot = process.env.STORAGE_DIR ?? './storage-test';
  const avatar = path.join(storageRoot, 'avatars', 'security-headers.png');

  beforeAll(async () => {
    await fs.mkdir(path.dirname(avatar), { recursive: true });
    await fs.writeFile(avatar, Buffer.from('PNGDATA'));
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    applySecurity(app);
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    setupSwagger(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(avatar, { force: true });
  });

  it('aplica las cabeceras de helmet en las respuestas de la API', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-dns-prefetch-control']).toBe('off');
    expect(res.headers['content-security-policy']).toContain(
      "default-src 'self'",
    );
    expect(res.headers['content-security-policy']).toContain(
      "frame-ancestors 'self'",
    );
    // Por defecto los recursos de la API no se pueden incrustar desde otro origen.
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('solo /files (avatares) se puede incrustar desde la web (otro origen)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/files/avatars/security-headers.png')
      .expect(200);
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sirve Swagger UI en /docs con una CSP compatible', async () => {
    const res = await request(app.getHttpServer()).get('/docs').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    const csp = res.headers['content-security-policy'];
    // Swagger UI carga sus scripts desde el mismo origen y usa estilos en línea
    // e imágenes data:.
    expect(csp).toContain("script-src 'self'");
    expect(csp).toMatch(/style-src [^;]*'unsafe-inline'/);
    expect(csp).toMatch(/img-src [^;]*data:/);
    // Sin upgrade-insecure-requests: rompería /docs servido por http (dev/LAN).
    expect(csp).not.toContain('upgrade-insecure-requests');
    expect(res.text).toContain('swagger-ui-init.js');

    await request(app.getHttpServer())
      .get('/docs/swagger-ui-init.js')
      .expect(200);
    await request(app.getHttpServer()).get('/docs-json').expect(200);
  });

  it('mantiene CORS para la web con credenciales y la cabecera de sede', async () => {
    const res = await request(app.getHttpServer())
      .options('/api/v1/auth/login')
      .set('Origin', 'http://localhost:3001')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-location-id');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:3001',
    );
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-headers']).toMatch(
      /X-Location-Id/,
    );
  });

  it('deja pasar Idempotency-Key en el preflight (abonos desde el navegador, DX-067)', async () => {
    const res = await request(app.getHttpServer())
      .options(
        '/api/v1/treatment-plans/00000000-0000-4000-8000-000000000000/payments',
      )
      .set('Origin', 'http://localhost:3001')
      .set('Access-Control-Request-Method', 'POST')
      .set(
        'Access-Control-Request-Headers',
        'authorization,content-type,idempotency-key,x-tenant-host',
      );
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers']).toMatch(
      /Idempotency-Key/,
    );
  });

  it('acepta subdominios del dominio raíz (marca blanca)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', 'http://acme.dentalix.local')
      .expect(200);
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://acme.dentalix.local',
    );
  });
});
