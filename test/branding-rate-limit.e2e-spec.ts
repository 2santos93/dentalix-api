import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { applySecurity } from '../src/shared/security/apply-security';
import {
  RATE_LIMIT_CONFIG,
  RateLimitConfig,
  loadRateLimitConfig,
} from '../src/shared/security/rate-limit.config';
import { tooManyRequestsException } from '../src/shared/security/too-many-requests';
import { loadSecuritySettings } from '../src/shared/security/security-settings';
import { brandingRejections } from '../src/shared/security/rate-limit-rejection-log';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import {
  REGIONAL_CARACAS_FIXTURE,
  registerBody,
} from './support/location-fixtures';

// DX-555: la marca por host que pide el servidor web en el render. Todas sus
// llamadas salen de UNA IP (la del servidor web): aquí cada «cliente» es una
// IP distinta por X-Forwarded-For, con un salto de proxy de confianza, como
// en producción (balanceador -> Next -> API).
const BY_HOST = '/api/v1/public/tenant/branding/by-host';
const NEXT_IP = '198.51.100.10';

// Límites bajos SOLO en lo que se prueba; el resto, los altos del entorno de
// e2e (test/setup-e2e.ts). El global es más bajo que los dos baldes propios
// para demostrar que esta ruta ya no lo gasta.
const limits = (): RateLimitConfig => ({
  ...loadRateLimitConfig((k) => process.env[k]),
  global: { limit: 2, ttlMs: 60_000 },
  'branding-host': { limit: 4, ttlMs: 60_000 },
  'branding-miss': { limit: 3, ttlMs: 60_000 },
});

function expectTooMany(res: request.Response): void {
  expect(res.status).toBe(429);
  const retryAfter = Number(res.headers['retry-after']);
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(60);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body).toEqual(tooManyRequestsException(retryAfter).getResponse());
}

describe('Marca por host: límites propios (DX-555, e2e)', () => {
  let app: INestApplication<App>;
  const suffix = Date.now().toString(36);
  const subdomain = `dx555-${suffix}`;
  const realHost = hostFor(subdomain);
  // Hosts bien formados que no son de ninguna clínica.
  const invented = (i: number | string) =>
    hostFor(`dx555-nadie-${suffix}-${i}`);

  const byHost = (ip: string, host: string) =>
    request(app.getHttpServer())
      .get(BY_HOST)
      .set('X-Forwarded-For', ip)
      .query({ host });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RATE_LIMIT_CONFIG)
      .useValue(limits())
      .compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    applySecurity(app, {
      ...loadSecuritySettings((k) => process.env[k]),
      trustProxyHops: 1,
    });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    await app.listen(0, '127.0.0.1');

    await registerVerified(
      app,
      registerBody(REGIONAL_CARACAS_FIXTURE, {
        clinicName: 'Sonrisa Límites',
        subdomain,
        email: `owner@${subdomain}.com.ve`,
        password: 'S3cret!!-largo',
        fullName: 'Dra. Límites',
      }),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('un aluvión de hosts inventados desde el servidor web NO deja sin marca a una clínica real', async () => {
    const warn = jest.spyOn(brandingRejections, 'record');
    // El aluvión: los primeros fallos son el 404 de siempre…
    for (let i = 0; i < 3; i++) {
      expect((await byHost(NEXT_IP, invented(i))).status).toBe(404);
    }
    // …y al pasar el balde de fallos de esa IP, 429 (también para un host mal
    // formado, que es un fallo más).
    expectTooMany(await byHost(NEXT_IP, invented('extra')));
    expectTooMany(await byHost(NEXT_IP, 'a..b'));
    expect(warn).toHaveBeenCalledWith('branding-miss', expect.any(Number));
    warn.mockRestore();

    // La clínica real, desde la MISMA IP agotada de fallos, sigue con marca.
    const hit = await byHost(NEXT_IP, realHost).expect(200);
    expect(hit.body).toEqual(
      expect.objectContaining({ name: 'Sonrisa Límites' }),
    );
  });

  it('la enumeración desde un cliente externo choca con 429; otra IP no hereda su balde', async () => {
    const attacker = '203.0.113.7';
    for (let i = 0; i < 3; i++) {
      expect((await byHost(attacker, invented(`ext-${i}`))).status).toBe(404);
    }
    expectTooMany(await byHost(attacker, invented('ext-next')));
    // Otro cliente: su propio balde de fallos.
    expect((await byHost('203.0.113.8', invented('otro'))).status).toBe(404);
  });

  it('un host mal formado cuenta como fallo (sin llegar a la BD)', async () => {
    const ip = '203.0.113.20';
    for (const host of ['a..b', 'clinica.localhost/../x', '-x-.localhost']) {
      expect((await byHost(ip, host)).status).toBe(404);
    }
    expectTooMany(await byHost(ip, invented('tras-malformados')));
  });

  it('los aciertos no gastan el balde de fallos y van fuera del límite global (2/min aquí)', async () => {
    const ip = '203.0.113.30';
    // 4 aciertos (> global de 2) desde una IP: todos pasan.
    for (let i = 0; i < 4; i++) {
      await byHost(ip, realHost).expect(200);
    }
    // Y su balde de fallos sigue entero: 3 fallos 404 antes del 429.
    for (let i = 0; i < 3; i++) {
      expect((await byHost(ip, invented(`hit-${i}`))).status).toBe(404);
    }
    expectTooMany(await byHost(ip, invented('hit-next')));
  });

  it('branding-host: por IP + host normalizado; otra IP (el servidor web) no lo hereda', async () => {
    const ip = '203.0.113.40';
    const warn = jest.spyOn(brandingRejections, 'record');
    // Mayúsculas, puerto y punto final son el MISMO host (mismo balde).
    for (const host of [
      realHost,
      realHost.toUpperCase(),
      `${realHost}:3000`,
      `${realHost}.`,
    ]) {
      await byHost(ip, host).expect(200);
    }
    expectTooMany(await byHost(ip, realHost));
    expect(warn).toHaveBeenCalledWith('branding-host', expect.any(Number));
    warn.mockRestore();
    // Quien machaca el host de una clínica agota SU balde, no el del
    // servidor web: el render de esa clínica sigue con marca.
    await byHost('198.51.100.99', realHost).expect(200);
  });
});
