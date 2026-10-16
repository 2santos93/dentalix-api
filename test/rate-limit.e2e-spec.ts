import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { applySecurity } from '../src/shared/security/apply-security';
import {
  RATE_LIMIT_CONFIG,
  RateLimitConfig,
} from '../src/shared/security/rate-limit.config';
import { tooManyRequestsException } from '../src/shared/security/too-many-requests';
import {
  SecuritySettings,
  loadSecuritySettings,
} from '../src/shared/security/security-settings';

// Las demás suites e2e corren con límites altísimos (test/setup-e2e.ts) porque
// hacen decenas de logins desde 127.0.0.1. Aquí se FUERZAN límites bajos
// sustituyendo el proveedor de configuración, para demostrar el 429 real.
const LOW_LIMITS: RateLimitConfig = {
  global: { limit: 1000, ttlMs: 60_000 },
  auth: { limit: 8, ttlMs: 60_000 },
  login: { limit: 3, ttlMs: 60_000 },
  'login-account': { limit: 6, ttlMs: 60_000 },
  invitation: { limit: 2, ttlMs: 60_000 },
  password: { limit: 2, ttlMs: 60_000 },
  confirmation: { limit: 2, ttlMs: 60_000 },
  refresh: { limit: 4, ttlMs: 60_000 },
};

// JWT con `sub` pero sin firma válida: JwtAuthGuard lo rechaza (401), pero el
// limitador de me/password solo lo decodifica para separar baldes por usuario.
const fakeBearer = (sub: string): string =>
  'Bearer ' +
  [
    Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
    Buffer.from(JSON.stringify({ sub })).toString('base64url'),
    'firma-invalida',
  ].join('.');

async function buildApp(
  limits: RateLimitConfig,
  settings: Partial<SecuritySettings> = {},
): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RATE_LIMIT_CONFIG)
    .useValue(limits)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  applySecurity(app, {
    ...loadSecuritySettings((k) => process.env[k]),
    ...settings,
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  return app;
}

const login = (app: INestApplication<App>, email: string, xff?: string) => {
  const req = request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ email, password: 'Wrong-pass-1' });
  return xff ? req.set('X-Forwarded-For', xff) : req;
};

function expectTooMany(res: request.Response): void {
  expect(res.status).toBe(429);
  const retryAfter = Number(res.headers['retry-after']);
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(60);
  expect(res.body).toEqual(tooManyRequestsException(retryAfter).getResponse());
  // Solo Retry-After: sin las cabeceras X-RateLimit-* / Retry-After-<nombre>
  // de la librería (setHeaders: false).
  const extra = Object.keys(res.headers).filter(
    (h) => h.startsWith('x-ratelimit') || h.startsWith('retry-after-'),
  );
  expect(extra).toEqual([]);
}

describe('Rate limiting (e2e)', () => {
  describe('sin proxy de confianza (TRUST_PROXY=false)', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      app = await buildApp(LOW_LIMITS, { trustProxyHops: 0 });
    });

    afterAll(async () => {
      await app.close();
    });

    it('POST auth/login: bloquea por IP+email con 429 y Retry-After', async () => {
      for (let i = 0; i < LOW_LIMITS.login.limit; i++) {
        const res = await login(app, 'victim@sonrisa.com');
        expect(res.status).toBe(401);
      }
      expectTooMany(await login(app, 'victim@sonrisa.com'));
      // Mismo email con otra capitalización: mismo balde.
      expectTooMany(await login(app, 'VICTIM@sonrisa.com'));
    });

    it('rotar X-Forwarded-For no evade el límite si no hay proxy de confianza', async () => {
      expectTooMany(await login(app, 'victim@sonrisa.com', '203.0.113.9'));
    });

    it('otro email desde la misma IP sigue pudiendo intentar (balde IP+email)', async () => {
      const res = await login(app, 'other@sonrisa.com');
      expect(res.status).toBe(401);
    });

    it('POST auth/login: el balde por IP corta el "spraying" de muchos emails', async () => {
      // Los intentos previos (incluidos los rechazados con 429) ya consumieron
      // casi todo el balde `auth` por IP: unos pocos emails nuevos lo agotan.
      let last: request.Response | undefined;
      for (let i = 0; i < LOW_LIMITS.auth.limit; i++) {
        last = await login(app, `spray${i}@sonrisa.com`);
        if (last.status === 429) break;
      }
      expectTooMany(last as request.Response);
    });

    it('POST auth/register: 429 tras el límite por IP', async () => {
      for (let i = 0; i < LOW_LIMITS.auth.limit; i++) {
        const res = await request(app.getHttpServer())
          .post('/api/v1/auth/register')
          .send({});
        expect(res.status).toBe(400);
      }
      expectTooMany(
        await request(app.getHttpServer())
          .post('/api/v1/auth/register')
          .send({}),
      );
    });

    it('POST auth/refresh: política propia `refresh` y 429 tras su límite', async () => {
      // DX-062: el refresh no usa la política `auth` sino la suya (holgada en
      // producción, porque la web renueva en cada carga de página).
      for (let i = 0; i < LOW_LIMITS.refresh.limit; i++) {
        const res = await request(app.getHttpServer())
          .post('/api/v1/auth/refresh')
          .send({ refreshToken: 'nope' });
        expect(res.status).toBe(401);
      }
      expectTooMany(
        await request(app.getHttpServer())
          .post('/api/v1/auth/refresh')
          .send({ refreshToken: 'nope' }),
      );
    });

    it('GET public/invitations/:token: enumerar tokens choca con el límite por IP', async () => {
      for (let i = 0; i < LOW_LIMITS.invitation.limit; i++) {
        const res = await request(app.getHttpServer()).get(
          `/api/v1/public/invitations/guess-${i}`,
        );
        expect(res.status).not.toBe(429);
      }
      expectTooMany(
        await request(app.getHttpServer()).get(
          '/api/v1/public/invitations/guess-next',
        ),
      );
    });

    it('POST public/invitations/:token/accept: 429 tras el límite por IP', async () => {
      const accept = (token: string) =>
        request(app.getHttpServer())
          .post(`/api/v1/public/invitations/${token}/accept`)
          .send({ password: 'S3cret!!-long' });
      for (let i = 0; i < LOW_LIMITS.invitation.limit; i++) {
        expect((await accept(`guess-${i}`)).status).not.toBe(429);
      }
      expectTooMany(await accept('guess-next'));
    });

    it('GET y POST public/appointment-confirmations/:token: 429 tras el límite por IP (balde por ruta)', async () => {
      const view = (token: string) =>
        request(app.getHttpServer()).get(
          `/api/v1/public/appointment-confirmations/${token}`,
        );
      const respond = (token: string) =>
        request(app.getHttpServer())
          .post(`/api/v1/public/appointment-confirmations/${token}`)
          .send({ action: 'confirm' });
      for (let i = 0; i < LOW_LIMITS.confirmation.limit; i++) {
        expect((await view(`guess-${i}`)).status).not.toBe(429);
      }
      expectTooMany(await view('guess-next'));
      for (let i = 0; i < LOW_LIMITS.confirmation.limit; i++) {
        expect((await respond(`guess-${i}`)).status).not.toBe(429);
      }
      expectTooMany(await respond('guess-next'));
    });

    it('POST me/password: 429 por IP+usuario (se aplica antes del JWT)', async () => {
      const change = (sub: string) =>
        request(app.getHttpServer())
          .post('/api/v1/me/password')
          .set('Authorization', fakeBearer(sub))
          .send({ currentPassword: 'a', newPassword: 'b' });
      for (let i = 0; i < LOW_LIMITS.password.limit; i++) {
        expect((await change('user-1')).status).toBe(401);
      }
      expectTooMany(await change('user-1'));
      // Otro usuario de la misma clínica (misma IP por NAT) no queda bloqueado.
      expect((await change('user-2')).status).toBe(401);
    });

    it('health nunca se limita (@SkipThrottle)', async () => {
      for (let i = 0; i < 10; i++) {
        await request(app.getHttpServer()).get('/api/v1/health').expect(200);
      }
    });
  });

  describe('detrás de un proxy de confianza (TRUST_PROXY=true)', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      app = await buildApp(LOW_LIMITS, { trustProxyHops: 1 });
    });

    afterAll(async () => {
      await app.close();
    });

    it('limita por la IP real del cliente (X-Forwarded-For), no por la del proxy', async () => {
      for (let i = 0; i < LOW_LIMITS.login.limit; i++) {
        expect(
          (await login(app, 'victim@sonrisa.com', '198.51.100.1')).status,
        ).toBe(401);
      }
      expectTooMany(await login(app, 'victim@sonrisa.com', '198.51.100.1'));
      // Otro cliente detrás del mismo proxy no hereda el bloqueo.
      expect(
        (await login(app, 'victim@sonrisa.com', '198.51.100.2')).status,
      ).toBe(401);
    });

    it('login-account: frena la fuerza bruta distribuida contra un email desde muchas IPs', async () => {
      const email = 'distributed@sonrisa.com';
      for (let i = 0; i < LOW_LIMITS['login-account'].limit; i++) {
        expect((await login(app, email, `203.0.113.${i + 1}`)).status).toBe(
          401,
        );
      }
      expectTooMany(await login(app, email, '203.0.113.200'));
    });

    it('solo confía en el salto del proxy: un X-Forwarded-For prefijado por el cliente no cambia la clave', async () => {
      // El proxy AÑADE la IP real al final; lo que el cliente ponga delante se
      // ignora con 1 salto de confianza.
      expectTooMany(
        await login(app, 'victim@sonrisa.com', '10.9.9.9, 198.51.100.1'),
      );
    });
  });

  describe('límite global', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      app = await buildApp({
        ...LOW_LIMITS,
        global: { limit: 3, ttlMs: 60_000 },
      });
    });

    afterAll(async () => {
      await app.close();
    });

    it('aplica a cualquier ruta con un 429 en el mismo formato', async () => {
      const branding = () =>
        request(app.getHttpServer()).get('/api/v1/public/tenant/branding');
      for (let i = 0; i < 3; i++) {
        expect((await branding()).status).not.toBe(429);
      }
      expectTooMany(await branding());
    });

    it('health queda fuera incluso del límite global', async () => {
      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer()).get('/api/v1/health').expect(200);
      }
    });
  });
});
