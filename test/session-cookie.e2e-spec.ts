import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { applySecurity } from '../src/shared/security/apply-security';
import { loadSecuritySettings } from '../src/shared/security/security-settings';
import {
  REFRESH_COOKIE,
  SessionCookieService,
} from '../src/modules/auth/presentation/session-cookie.service';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { CapturingMailer } from './support/capture-mailer';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import {
  REGIONAL_BOGOTA_FIXTURE,
  registerBody,
} from './support/location-fixtures';
import { purgeTenants } from './support/tenant-purge';

// DX-062: el refresh de la web viaja en una cookie HttpOnly del host de la
// clínica (la web llama a la API por su mismo origen). Compatibilidad con el
// refresh en el body, CSRF por Origin, aislamiento por clínica y CORS con
// credenciales solo para orígenes de Dentalix.
//
// Los orígenes de la web en local son `http://<clínica>.localhost:3001`, así
// que la app se monta con CORS_ROOT_DOMAIN=localhost (como en `.env`).
const ENV: Record<string, string> = {
  CORS_ORIGINS: 'http://localhost:3001',
  CORS_ROOT_DOMAIN: 'localhost',
};

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SUB_A = 'cookie-a-e2e';
const SUB_B = 'cookie-b-e2e';
const DOMAIN = '@cookie-e2e.com';
const PASSWORD = 'CookiePass1!';
const COOKIE_MODE = { 'X-Refresh-Transport': 'cookie' };

const webOrigin = (sub: string) => `http://${hostFor(sub)}:3001`;
const webHost = (sub: string) => `${hostFor(sub)}:3001`;

/** Cabeceras de una petición de la web de la clínica `sub` (mismo origen). */
const fromWeb = (sub: string) => ({
  Origin: webOrigin(sub),
  'X-Tenant-Host': webHost(sub),
});

function setCookies(res: request.Response): string[] {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  return header ?? [];
}

function sessionCookie(res: request.Response): string | undefined {
  return setCookies(res).find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
}

/** Valor del refresh en el Set-Cookie de la respuesta. */
function refreshFrom(res: request.Response): string {
  const cookie = sessionCookie(res);
  expect(cookie).toBeDefined();
  const value = (cookie as string)
    .split(';')[0]
    .slice(REFRESH_COOKIE.length + 1);
  expect(value).not.toBe('');
  return value;
}

const cookieHeader = (refresh: string) => `${REFRESH_COOKIE}=${refresh}`;

/** Claves del body con valor string no vacío (para comparar la forma). */
function bodyKeys(res: request.Response): string[] {
  const body = res.body as Record<string, unknown>;
  return Object.keys(body)
    .filter((k) => typeof body[k] === 'string' && body[k] !== '')
    .sort();
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: [SUB_A, SUB_B] } },
    select: { id: true },
  });
  await purgeTenants(
    raw,
    tenants.map((t) => t.id),
  );
  await raw.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
}

describe('Refresh en cookie HttpOnly (e2e, DX-062)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());

  async function register(sub: string, email: string): Promise<void> {
    await registerVerified(
      app,
      registerBody(REGIONAL_BOGOTA_FIXTURE, {
        clinicName: `Clínica ${sub}`,
        subdomain: sub,
        email,
        password: PASSWORD,
        fullName: 'Dueña Cookie',
      }),
    );
  }

  /** Login en modo cookie desde la web de `sub`; devuelve la respuesta. */
  async function cookieLogin(
    sub: string,
    email: string,
  ): Promise<request.Response> {
    return http()
      .post('/api/v1/auth/login')
      .set(fromWeb(sub))
      .set(COOKIE_MODE)
      .send({ email, password: PASSWORD })
      .expect(201);
  }

  const mailer = new CapturingMailer();

  beforeAll(async () => {
    const env = (k: string) => ENV[k] ?? process.env[k];
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SessionCookieService)
      .useValue(
        new SessionCookieService({
          get: env,
        } as unknown as ConfigService),
      )
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
    await register(SUB_A, `owner-a${DOMAIN}`);
    await register(SUB_B, `owner-b${DOMAIN}`);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  describe('emisión', () => {
    it('login en modo cookie: Set-Cookie HttpOnly/Strict/Path=/api/v1/auth sin Domain y el refresh NO va en el body', async () => {
      const res = await cookieLogin(SUB_A, `owner-a${DOMAIN}`);

      const body = res.body as { accessToken?: string; refreshToken?: string };
      expect(body.accessToken).toEqual(expect.any(String));
      expect(body).not.toHaveProperty('refreshToken');

      const cookie = sessionCookie(res) as string;
      expect(cookie).toBeDefined();
      expect(cookie).toMatch(/;\s*HttpOnly/i);
      expect(cookie).toMatch(/;\s*SameSite=Strict/i);
      expect(cookie).toMatch(/;\s*Path=\/api\/v1\/auth(;|$)/i);
      expect(cookie).toMatch(/;\s*Max-Age=\d+/i);
      expect(cookie).not.toMatch(/Domain=/i);
      // Fuera de producción no se marca Secure (http://*.localhost).
      expect(cookie).not.toMatch(/;\s*Secure/i);
    });

    it('cliente antiguo (sin X-Refresh-Transport): el par en el body y sin cookie', async () => {
      const res = await http()
        .post('/api/v1/auth/login')
        .set('X-Tenant-Host', hostFor(SUB_A))
        .send({ email: `owner-a${DOMAIN}`, password: PASSWORD })
        .expect(201);

      expect(bodyKeys(res)).toEqual(['accessToken', 'refreshToken']);
      expect(sessionCookie(res)).toBeUndefined();
    });
  });

  describe('refresh por cookie', () => {
    it('rota la cookie: el par nuevo llega en la cookie y la anterior da 401 (y se borra)', async () => {
      const first = refreshFrom(await cookieLogin(SUB_A, `owner-a${DOMAIN}`));

      const res = await http()
        .post('/api/v1/auth/refresh')
        .set(fromWeb(SUB_A))
        .set('Cookie', cookieHeader(first))
        .expect(201);
      expect(bodyKeys(res)).toEqual(['accessToken']);
      const second = refreshFrom(res);
      expect(second).not.toBe(first);

      const reused = await http()
        .post('/api/v1/auth/refresh')
        .set(fromWeb(SUB_A))
        .set('Cookie', cookieHeader(first))
        .expect(401);
      // La cookie muerta se borra para no reintentar con ella en cada carga.
      expect(sessionCookie(reused)).toMatch(/Expires=Thu, 01 Jan 1970/);

      // La cadena nueva sigue viva.
      await http()
        .post('/api/v1/auth/refresh')
        .set(fromWeb(SUB_A))
        .set('Cookie', cookieHeader(second))
        .expect(201);
    });

    it('sin cookie ni body → 401', async () => {
      await http()
        .post('/api/v1/auth/refresh')
        .set(fromWeb(SUB_A))
        .send({})
        .expect(401);
    });

    it.each([
      ['sin Origin', {}],
      ['con un Origin ajeno', { Origin: 'https://evil.example' }],
      ['con el Origin de OTRA clínica', { Origin: webOrigin(SUB_B) }],
      ['con Origin null', { Origin: 'null' }],
    ])('CSRF: refresh por cookie %s → 403', async (_label, origin) => {
      const refresh = refreshFrom(await cookieLogin(SUB_A, `owner-a${DOMAIN}`));

      await http()
        .post('/api/v1/auth/refresh')
        .set('X-Tenant-Host', webHost(SUB_A))
        .set(origin)
        .set('Cookie', cookieHeader(refresh))
        .expect(403);

      // El 403 no consume el token: desde la web legítima sigue sirviendo.
      await http()
        .post('/api/v1/auth/refresh')
        .set(fromWeb(SUB_A))
        .set('Cookie', cookieHeader(refresh))
        .expect(201);
    });
  });

  describe('aislamiento por clínica', () => {
    let crossEmail: string;

    beforeAll(async () => {
      // Una persona que es miembro de las DOS clínicas.
      crossEmail = `dos-clinicas${DOMAIN}`;
      const passwordHash = (
        await raw.user.findFirstOrThrow({
          where: { email: `owner-a${DOMAIN}` },
          select: { passwordHash: true },
        })
      ).passwordHash;
      const user = await raw.user.create({
        data: { email: crossEmail, passwordHash, fullName: 'Dos Clínicas' },
        select: { id: true },
      });
      for (const sub of [SUB_A, SUB_B]) {
        const tenant = await raw.tenant.findFirstOrThrow({
          where: { subdomain: sub },
          select: { id: true },
        });
        await raw.clinicMembership.create({
          data: {
            tenantId: tenant.id,
            userId: user.id,
            role: ClinicRole.DENTIST,
          },
        });
      }
    });

    it('la cookie de la clínica A no renueva sesión en el host de la clínica B (401, sin consumirla)', async () => {
      const refreshA = refreshFrom(await cookieLogin(SUB_A, crossEmail));

      await http()
        .post('/api/v1/auth/refresh')
        .set(fromWeb(SUB_B))
        .set('Cookie', cookieHeader(refreshA))
        .expect(401);

      // En su propia clínica sigue valiendo.
      await http()
        .post('/api/v1/auth/refresh')
        .set(fromWeb(SUB_A))
        .set('Cookie', cookieHeader(refreshA))
        .expect(201);
    });

    it('tampoco por el body: un refresh de A presentado en el host de B → 401', async () => {
      const login = await http()
        .post('/api/v1/auth/login')
        .set('X-Tenant-Host', hostFor(SUB_A))
        .send({ email: crossEmail, password: PASSWORD })
        .expect(201);
      const { refreshToken } = login.body as { refreshToken: string };

      await http()
        .post('/api/v1/auth/refresh')
        .set('X-Tenant-Host', hostFor(SUB_B))
        .send({ refreshToken })
        .expect(401);
    });
  });

  describe('compatibilidad con el refresh en el body', () => {
    it('sin modo cookie: body → par en el body, como siempre', async () => {
      const login = await http()
        .post('/api/v1/auth/login')
        .set('X-Tenant-Host', hostFor(SUB_A))
        .send({ email: `owner-a${DOMAIN}`, password: PASSWORD })
        .expect(201);
      const { refreshToken } = login.body as { refreshToken: string };

      const res = await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken })
        .expect(201);
      expect(bodyKeys(res)).toEqual(['accessToken', 'refreshToken']);
      expect(sessionCookie(res)).toBeUndefined();
    });

    it('migración: refresh antiguo en el body + modo cookie → la sesión pasa a la cookie', async () => {
      const login = await http()
        .post('/api/v1/auth/login')
        .set('X-Tenant-Host', hostFor(SUB_A))
        .send({ email: `owner-a${DOMAIN}`, password: PASSWORD })
        .expect(201);
      const { refreshToken } = login.body as { refreshToken: string };

      const res = await http()
        .post('/api/v1/auth/refresh')
        .set(fromWeb(SUB_A))
        .set(COOKIE_MODE)
        .send({ refreshToken })
        .expect(201);
      expect(bodyKeys(res)).toEqual(['accessToken']);
      const cookieRefresh = refreshFrom(res);

      await http()
        .post('/api/v1/auth/refresh')
        .set(fromWeb(SUB_A))
        .set('Cookie', cookieHeader(cookieRefresh))
        .expect(201);
    });
  });

  describe('logout', () => {
    it('por cookie: revoca el refresh, borra la cookie y el refresh anterior da 401', async () => {
      const refresh = refreshFrom(await cookieLogin(SUB_A, `owner-a${DOMAIN}`));

      const res = await http()
        .post('/api/v1/auth/logout')
        .set(fromWeb(SUB_A))
        .set('Cookie', cookieHeader(refresh))
        .expect(204);
      const cleared = sessionCookie(res) as string;
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(cleared).toMatch(/;\s*Path=\/api\/v1\/auth/i);

      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: refresh })
        .expect(401);
    });

    it('CSRF: logout por cookie desde un origen ajeno → 403 y la sesión sigue viva', async () => {
      const refresh = refreshFrom(await cookieLogin(SUB_A, `owner-a${DOMAIN}`));

      await http()
        .post('/api/v1/auth/logout')
        .set('X-Tenant-Host', webHost(SUB_A))
        .set('Origin', 'https://evil.example')
        .set('Cookie', cookieHeader(refresh))
        .expect(403);

      await http()
        .post('/api/v1/auth/refresh')
        .set(fromWeb(SUB_A))
        .set('Cookie', cookieHeader(refresh))
        .expect(201);
    });

    it('sin cookie ni body sigue siendo 204 (idempotente)', async () => {
      await http()
        .post('/api/v1/auth/logout')
        .set(fromWeb(SUB_A))
        .send({})
        .expect(204);
    });
  });

  describe('otros endpoints que emiten el par', () => {
    it('cambio de contraseña en modo cookie: la sesión nueva llega en la cookie', async () => {
      const login = await cookieLogin(SUB_A, `owner-a${DOMAIN}`);
      const { accessToken } = login.body as { accessToken: string };

      const res = await http()
        .post('/api/v1/me/password')
        .set(fromWeb(SUB_A))
        .set(COOKIE_MODE)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: PASSWORD, newPassword: PASSWORD })
        .expect(200);
      expect(bodyKeys(res)).toEqual(['accessToken']);
      const refresh = refreshFrom(res);

      await http()
        .post('/api/v1/auth/refresh')
        .set(fromWeb(SUB_A))
        .set('Cookie', cookieHeader(refresh))
        .expect(201);
    });

    it('aceptar una invitación en modo cookie: la sesión llega en la cookie', async () => {
      const owner = await cookieLogin(SUB_A, `owner-a${DOMAIN}`);
      const { accessToken } = owner.body as { accessToken: string };
      const invite = await http()
        .post('/api/v1/staff/invitations')
        .set('X-Tenant-Host', hostFor(SUB_A))
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          fullName: 'Invitada Cookie',
          email: `invitada${DOMAIN}`,
          role: ClinicRole.ASSISTANT,
        })
        .expect(201);
      expect(invite.body).not.toHaveProperty('token');
      // DX-029: el enlace solo viaja por email.
      const token = await mailer.invitationToken(`invitada${DOMAIN}`);

      const res = await http()
        .post(`/api/v1/public/invitations/${token}/accept`)
        .set(fromWeb(SUB_A))
        .set(COOKIE_MODE)
        .send({ password: PASSWORD })
        .expect(201);
      expect(bodyKeys(res)).toEqual(['accessToken']);
      const refresh = refreshFrom(res);

      await http()
        .post('/api/v1/auth/refresh')
        .set(fromWeb(SUB_A))
        .set('Cookie', cookieHeader(refresh))
        .expect(201);
    });
  });

  describe('CORS con credenciales', () => {
    it('un origen de clínica recibe Allow-Credentials y puede mandar X-Refresh-Transport', async () => {
      const res = await http()
        .options('/api/v1/auth/refresh')
        .set('Origin', webOrigin(SUB_A))
        .set('Access-Control-Request-Method', 'POST')
        .set(
          'Access-Control-Request-Headers',
          'content-type,x-refresh-transport',
        );
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(webOrigin(SUB_A));
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-allow-headers']).toMatch(
        /X-Refresh-Transport/,
      );
    });

    it.each(['https://evil.example', 'http://localhost.evil.example:3001'])(
      'un origen ajeno (%s) NO recibe Allow-Credentials ni Allow-Origin',
      async (origin) => {
        const preflight = await http()
          .options('/api/v1/auth/refresh')
          .set('Origin', origin)
          .set('Access-Control-Request-Method', 'POST');
        // Se corta antes del handler: 403 y sin cabeceras CORS.
        expect(preflight.status).toBe(403);
        expect(
          preflight.headers['access-control-allow-credentials'],
        ).toBeUndefined();
        expect(
          preflight.headers['access-control-allow-origin'],
        ).toBeUndefined();

        const simple = await http().get('/api/v1/health').set('Origin', origin);
        expect(
          simple.headers['access-control-allow-credentials'],
        ).toBeUndefined();
        expect(simple.headers['access-control-allow-origin']).toBeUndefined();
      },
    );
  });
});
