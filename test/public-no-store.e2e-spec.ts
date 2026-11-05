import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { CapturingMailer } from './support/capture-mailer';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { isNoStoreExempt } from './support/public-no-store';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import { JwtAuthGuard } from '../src/modules/auth/presentation/guards/jwt-auth.guard';
import { ModulesContainer } from '@nestjs/core';
import { Controller, discoverRoutes } from './support/route-discovery';
import {
  REGIONAL_CARACAS_FIXTURE,
  registerBody,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';

// SEC-064: TODA ruta pública de la API (enlaces por token del paciente, login,
// registro, recuperación de contraseña...) responde con
// `Cache-Control: no-store` y `Pragma: no-cache`, sea cual sea el estado
// (200, 400, 401, 404). El recorrido sale de las rutas REALES de AppModule: una
// ruta pública nueva sin la cabecera rompe este test. La parte estática la
// cubre `src/public-no-store.spec.ts`; esta comprueba la respuesta HTTP.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const SUB = 'sec064-a';
const DOMAIN = '@sec064.test';
const PASSWORD = 'Clave-Sec064-2026!';
// 43 caracteres URL-safe: pasa la forma de un token real y no existe.
const FAKE_TOKEN = 'A'.repeat(43);

async function cleanup(): Promise<void> {
  await purgeTenantsBySubdomain(raw, [SUB]);
  await raw.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await raw.pendingRegistration.deleteMany({
    where: { email: { endsWith: DOMAIN } },
  });
}

describe('Rutas públicas con no-store (e2e, SEC-064)', () => {
  let app: INestApplication<App>;
  const mailer = new CapturingMailer();
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    await cleanup();
    app = await createE2eApp({
      override: (builder) => builder.overrideProvider(MAILER).useValue(mailer),
    });
    await registerVerified(
      app,
      registerBody(REGIONAL_CARACAS_FIXTURE, {
        clinicName: 'Clínica SEC-064',
        subdomain: SUB,
        email: `owner${DOMAIN}`,
        password: PASSWORD,
        fullName: 'Dra. Dueña',
      }),
    );
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
    await raw.$disconnect();
  });

  // Los controladores que Nest montó de verdad (el ConfigModule real es
  // asíncrono y `collectControllers` no lo recorre en estático).
  function publicRoutes() {
    const controllers = [...app.get(ModulesContainer).values()].flatMap((m) =>
      [...m.controllers.keys()].filter(
        (token): token is Controller => typeof token === 'function',
      ),
    );
    return discoverRoutes(controllers).filter(
      (r) =>
        !r.guards.some(
          (g) =>
            g === JwtAuthGuard ||
            g instanceof (JwtAuthGuard as new (...a: never[]) => object),
        ) && !isNoStoreExempt(r.key),
    );
  }

  it('toda ruta pública lleva Cache-Control: no-store y Pragma: no-cache', async () => {
    const routes = publicRoutes();
    const keys = routes.map((r) => r.key);
    expect(keys.length).toBeGreaterThan(30);
    expect(keys).toEqual(
      expect.arrayContaining([
        'GET /public/slot-offers/:token',
        'GET /public/signed-consent-copies/:token',
      ]),
    );
    const failures: string[] = [];
    for (const { key } of routes) {
      const [verb, path] = key.split(' ');
      const url = `/api/v1${path.replace(/:[A-Za-z]+/g, FAKE_TOKEN)}`;
      const call =
        verb === 'GET'
          ? http().get(url)
          : http()
              .post(url)
              .send({ email: `x${DOMAIN}` });
      const res = await call.set('X-Tenant-Host', hostFor(SUB));
      // Un 429 lo corta el limitador antes de cualquier interceptor: no dice
      // nada de la ruta, así que se declara como fallo en vez de pasar.
      if (
        res.status === 429 ||
        res.headers['cache-control'] !== 'no-store' ||
        res.headers['pragma'] !== 'no-cache'
      ) {
        failures.push(
          `${key} → ${res.status} cache-control=${String(res.headers['cache-control'])} pragma=${String(res.headers['pragma'])}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('con una oferta o una copia que no existe (404) y con un host sin clínica', async () => {
    for (const path of [
      `/api/v1/public/slot-offers/${FAKE_TOKEN}`,
      `/api/v1/public/signed-consent-copies/${FAKE_TOKEN}`,
    ]) {
      for (const host of [hostFor(SUB), hostFor('sec064-no-existe')]) {
        const res = await http().get(path).set('X-Tenant-Host', host);
        expect(res.status).toBe(404);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['pragma']).toBe('no-cache');
      }
    }
  });

  it('una respuesta 200 pública también (marca de la clínica) y el login con clave mala (401)', async () => {
    const branding = await http()
      .get('/api/v1/public/tenant/branding')
      .set('X-Tenant-Host', hostFor(SUB))
      .expect(200);
    expect(branding.headers['cache-control']).toBe('no-store');
    const login = await http()
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(SUB))
      .send({ email: `owner${DOMAIN}`, password: 'incorrecta-123' })
      .expect(401);
    expect(login.headers['cache-control']).toBe('no-store');
    expect(login.headers['pragma']).toBe('no-cache');
  });

  it('las rutas con sesión NO cambian de política (no se les añade no-store por esto)', async () => {
    const res = await http().get('/api/v1/health').expect(200);
    expect(res.headers['cache-control']).toBeUndefined();
  });
});
