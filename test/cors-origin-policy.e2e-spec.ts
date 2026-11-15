import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { applySecurity } from '../src/shared/security/apply-security';
import { loadSecuritySettings } from '../src/shared/security/security-settings';
import { VerifiedDomainOrigins } from '../src/shared/security/verified-domain-origins';
import {
  REFRESH_COOKIE,
  SessionCookieService,
} from '../src/modules/auth/presentation/session-cookie.service';
import { registerVerified } from './support/register-verified';
import { CapturingMailer } from './support/capture-mailer';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import {
  REGIONAL_CARACAS_FIXTURE,
  registerBody,
} from './support/location-fixtures';
import { purgeTenants } from './support/tenant-purge';

// SEC-021: política de orígenes en PRODUCCIÓN simulada. CORS y el check de
// Origin del refresh por cookie se montan con NODE_ENV=production (sin tocar
// process.env, que validaría el resto del entorno de producción): el raíz y
// sus subdominios solo con https y puerto estándar, y los dominios propios
// VERIFIED (https) también valen; un PENDING no.
const ENV: Record<string, string> = {
  NODE_ENV: 'production',
  CORS_ORIGINS: 'https://dentalix.app',
  CORS_ROOT_DOMAIN: 'dentalix.app',
};

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SUB = 'sec021-cors-e2e';
const EMAIL = 'owner@sec021-cors-e2e.com';
const PASSWORD = 'Sec021Pass1!';
const VERIFIED = 'citas.sec021-e2e.com';
const PENDING = 'agenda.sec021-e2e.com';
const COOKIE_MODE = { 'X-Refresh-Transport': 'cookie' };

const cookieOf = (res: request.Response): string | undefined =>
  ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? []).find(
    (c) => c.startsWith(`${REFRESH_COOKIE}=`),
  );

function refreshFrom(res: request.Response): string {
  const cookie = cookieOf(res);
  expect(cookie).toBeDefined();
  return (cookie as string).split(';')[0].slice(REFRESH_COOKIE.length + 1);
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: SUB },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  await raw.tenantDomain.deleteMany({ where: { tenantId: { in: ids } } });
  await purgeTenants(raw, ids);
  await raw.user.deleteMany({ where: { email: EMAIL } });
}

describe('Política de orígenes en producción (e2e, SEC-021)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());
  const mailer = new CapturingMailer();

  /** Login en modo cookie desde la web servida en `host` (mismo origen). */
  const cookieLogin = (host: string) =>
    http()
      .post('/api/v1/auth/login')
      .set({ Origin: `https://${host}`, 'X-Tenant-Host': host })
      .set(COOKIE_MODE)
      .send({ email: EMAIL, password: PASSWORD });

  const preflight = (origin: string) =>
    http()
      .options('/api/v1/auth/refresh')
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST')
      .set(
        'Access-Control-Request-Headers',
        'content-type,x-refresh-transport',
      );

  beforeAll(async () => {
    const env = (k: string) => ENV[k] ?? process.env[k];
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SessionCookieService)
      .useFactory({
        inject: [VerifiedDomainOrigins],
        factory: (origins: VerifiedDomainOrigins) =>
          new SessionCookieService(
            { get: env } as unknown as ConfigService,
            origins,
          ),
      })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();
    app = moduleRef.createNestApplication();
    applySecurity(app, loadSecuritySettings(env));
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    await app.listen(0, '127.0.0.1');

    await cleanup();
    const {
      body: { tenantId },
    } = await registerVerified(
      app,
      registerBody(REGIONAL_CARACAS_FIXTURE, {
        clinicName: 'Clínica Origen Propio',
        subdomain: SUB,
        email: EMAIL,
        password: PASSWORD,
        fullName: 'Dueña Origen',
      }),
    );
    await raw.tenantDomain.createMany({
      data: [
        {
          tenantId,
          host: VERIFIED,
          status: 'VERIFIED',
          verifyToken: 'tok-verified',
          verifiedAt: new Date(),
          expiresAt: null,
        },
        {
          tenantId,
          host: PENDING,
          status: 'PENDING',
          verifyToken: 'tok-pending',
        },
      ],
    });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  describe('preflight CORS', () => {
    it.each([
      `https://${SUB}.dentalix.app`,
      'https://dentalix.app',
      `https://${VERIFIED}`,
    ])('%s → 204 con Allow-Origin y Allow-Credentials', async (origin) => {
      const res = await preflight(origin);
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it.each([
      `http://${SUB}.dentalix.app`,
      `https://${SUB}.dentalix.app:8443`,
      `https://${PENDING}`,
      `http://${VERIFIED}`,
      'https://desconocido.sec021-e2e.com',
      `http://${SUB}.localhost:3001`,
    ])('%s → 403 sin cabeceras CORS', async (origin) => {
      const res = await preflight(origin);
      expect(res.status).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });
  });

  describe('refresh por cookie desde el dominio propio', () => {
    it('Origin del dominio propio VERIFIED en su host → 201 y rota la cookie', async () => {
      const login = await cookieLogin(VERIFIED).expect(201);
      const first = refreshFrom(login);
      // Producción: la cookie va marcada Secure.
      expect(cookieOf(login)).toMatch(/;\s*Secure/i);

      const res = await http()
        .post('/api/v1/auth/refresh')
        .set({ Origin: `https://${VERIFIED}`, 'X-Tenant-Host': VERIFIED })
        .set('Cookie', `${REFRESH_COOKIE}=${first}`)
        .expect(201);
      expect(refreshFrom(res)).not.toBe(first);
    });

    it('Origin de un dominio PENDING → 403', async () => {
      const first = refreshFrom(await cookieLogin(VERIFIED).expect(201));
      await http()
        .post('/api/v1/auth/refresh')
        .set({ Origin: `https://${PENDING}`, 'X-Tenant-Host': PENDING })
        .set('Cookie', `${REFRESH_COOKIE}=${first}`)
        .expect(403);
    });

    it('Origin VERIFIED pero de OTRO host que la petición → 403 (check del refresh, no de CORS)', async () => {
      const first = refreshFrom(await cookieLogin(VERIFIED).expect(201));
      await http()
        .post('/api/v1/auth/refresh')
        .set({
          Origin: `https://${VERIFIED}`,
          'X-Tenant-Host': `${SUB}.dentalix.app`,
        })
        .set('Cookie', `${REFRESH_COOKIE}=${first}`)
        .expect(403);
    });
  });
});
