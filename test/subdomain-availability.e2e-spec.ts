import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import { CapturingMailer } from './support/capture-mailer';
import { registerVerified } from './support/register-verified';
import {
  REGIONAL_BOGOTA_FIXTURE,
  registerBody,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';

// Disponibilidad de la dirección web en el registro: mismas reglas que
// POST /auth/register (formato DNS, reservadas de la plataforma, ocupada
// también por una clínica dada de baja), siempre 200 y sin caché.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const TAKEN = 'ocupada-subd-e2e';
const RETIRED = 'retirada-subd-e2e';
const FREE = 'libre-subd-e2e';
const DOMAIN = '@subd-e2e.com';

async function cleanup(): Promise<void> {
  await purgeTenantsBySubdomain(raw, [TAKEN, RETIRED, FREE]);
  await raw.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
}

describe('GET /public/subdomains/:slug/availability (e2e)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());
  const check = (slug: string) =>
    http().get(
      `/api/v1/public/subdomains/${encodeURIComponent(slug)}/availability`,
    );
  const mailer = new CapturingMailer();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    await cleanup();
    for (const sub of [TAKEN, RETIRED]) {
      await registerVerified(
        app,
        registerBody(REGIONAL_BOGOTA_FIXTURE, {
          clinicName: `Clínica ${sub}`,
          subdomain: sub,
          email: `${sub}${DOMAIN}`,
          password: 'SubdPass1!',
          fullName: 'Dueña Subd',
        }),
      );
    }
    await raw.tenant.update({
      where: { subdomain: RETIRED },
      data: { deletedAt: new Date() },
    });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  it('libre: available, normalizada y sin caché', async () => {
    const res = await check(`  ${FREE.toUpperCase()} `).expect(200);
    expect(res.body).toEqual({ subdomain: FREE, status: 'available' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('de una clínica: taken, sin revelar nada de ella', async () => {
    const res = await check(TAKEN).expect(200);
    expect(res.body).toEqual({ subdomain: TAKEN, status: 'taken' });
  });

  it('de una clínica dada de baja: taken (la dirección sigue siendo suya)', async () => {
    const res = await check(RETIRED).expect(200);
    expect(res.body).toEqual({ subdomain: RETIRED, status: 'taken' });
  });

  it.each(['www', 'api', 'app', 'admin'])(
    '%p: reserved (dirección de la plataforma)',
    async (slug) => {
      const res = await check(slug).expect(200);
      expect(res.body).toEqual({ subdomain: slug, status: 'reserved' });
    },
  );

  it.each([
    '-sonrisa',
    'sonrisa-',
    'son_risa',
    'clínica',
    'xn--abc',
    'a'.repeat(64),
  ])('%p: invalid (200, no un error)', async (slug) => {
    const res = await check(slug).expect(200);
    expect((res.body as { status: string }).status).toBe('invalid');
  });

  it('una ruta desmesurada no se procesa: invalid con la dirección vacía', async () => {
    const res = await check('a'.repeat(500)).expect(200);
    expect(res.body).toEqual({ subdomain: '', status: 'invalid' });
  });

  describe('el registro aplica las MISMAS reglas', () => {
    const body = (subdomain: string) =>
      registerBody(REGIONAL_BOGOTA_FIXTURE, {
        clinicName: 'Clínica Reglas',
        subdomain,
        email: `reglas${DOMAIN}`,
        password: 'SubdPass1!',
        fullName: 'Dueña Reglas',
      });

    it('reservada → 409 SUBDOMAIN_RESERVED', async () => {
      const res = await http()
        .post('/api/v1/auth/register')
        .set('X-Tenant-Host', 'localhost')
        .send(body('admin'))
        .expect(409);
      expect(res.body).toMatchObject({ code: 'SUBDOMAIN_RESERVED' });
    });

    it('guion al final → 400', async () => {
      await http()
        .post('/api/v1/auth/register')
        .set('X-Tenant-Host', 'localhost')
        .send(body('sonrisa-'))
        .expect(400);
    });

    it('la de una clínica dada de baja → 409 (antes chocaba con la clave única)', async () => {
      await http()
        .post('/api/v1/auth/register')
        .set('X-Tenant-Host', 'localhost')
        .send(body(RETIRED))
        .expect(409);
    });

    it('la libre → 202', async () => {
      await http()
        .post('/api/v1/auth/register')
        .set('X-Tenant-Host', 'localhost')
        .send(body(FREE))
        .expect(202);
    });
  });
});
