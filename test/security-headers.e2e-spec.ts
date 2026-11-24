import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { promises as fs } from 'fs';
import * as path from 'path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { applySecurity } from '../src/shared/security/apply-security';
import {
  loadSecuritySettings,
  type SecuritySettings,
} from '../src/shared/security/security-settings';
import { setupSwagger } from '../src/config/swagger';
import { createAppValidationPipe } from '../src/shared/validation/app-validation-pipe';

// Construye la app igual que main.ts (applySecurity + Swagger) para verificar
// las cabeceras HTTP de seguridad tal como salen en producción.
//
// DX-419: los orígenes de CORS se leen de la configuración EFECTIVA de la app
// (la misma que usa applySecurity), no se dan por supuestos. `.env.test` se
// carga SOBRESCRIBIENDO el entorno (test/support/test-db-guard.ts), así que el
// `??=` de test/setup-e2e.ts no gana a un CORS_ROOT_DOMAIN o CORS_ORIGINS
// escrito ahí (p. ej. el de la demo local): con el dominio fijo
// «dentalix.local», «acepta subdominios del dominio raíz» fallaba en local y
// pasaba en la CI, cuyo `.env.test` no los trae.
describe('Cabeceras de seguridad (e2e)', () => {
  let app: INestApplication<App>;
  let settings: SecuritySettings;
  /** El primer origen exacto de CORS_ORIGINS (por defecto, la web en :3001). */
  let webOrigin: string;
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
    app.useGlobalPipes(createAppValidationPipe());
    setupSwagger(app);
    await app.init();
    await app.listen(0, '127.0.0.1');
    const config = app.get(ConfigService);
    settings = loadSecuritySettings((k) => config.get<string>(k));
    webOrigin = settings.corsOrigins[0];
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
    expect(webOrigin).toBeDefined();
    const res = await request(app.getHttpServer())
      .options('/api/v1/auth/login')
      .set('Origin', webOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-location-id');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(webOrigin);
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
      .set('Origin', webOrigin)
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

  it('deja pasar X-Signature-Session en el preflight (firma a distancia desde el navegador, DX-243)', async () => {
    const res = await request(app.getHttpServer())
      .options(`/api/v1/public/sign/${'A'.repeat(43)}/sign`)
      .set('Origin', webOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .set(
        'Access-Control-Request-Headers',
        'content-type,x-signature-session,x-tenant-host',
      );
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers']).toMatch(
      /X-Signature-Session/,
    );
  });

  it('acepta subdominios del dominio raíz (marca blanca)', async () => {
    const origin = `http://acme.${settings.corsRootDomain}`;
    const res = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', origin)
      .expect(200);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
  });

  it('rechaza un host que solo empieza como el dominio raíz', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/health')
      .set('Origin', `http://acme.${settings.corsRootDomain}.otro.test`)
      .expect(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
