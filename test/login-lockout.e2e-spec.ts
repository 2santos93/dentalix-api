import { INestApplication } from '@nestjs/common';
import { ClinicRole, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { performance } from 'node:perf_hooks';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  SEEDED_PASSWORD,
  loginAs,
  registerClinic,
  seedMember,
} from './support/e2e-fixtures';
import {
  DEFAULT_LOGIN_LOCKOUT,
  LOGIN_LOCKOUT_CONFIG,
  accountKeyHash,
  type LoginLockoutConfig,
} from '../src/modules/auth/domain/login-lockout';
import { loadSecuritySettings } from '../src/shared/security/security-settings';

/**
 * DX-048 (SEC-028): el login se bloquea por FALLOS, en la BD (vale entre
 * réplicas), con backoff por cuenta y un balde holgado por IP; los logins
 * correctos no cuentan. Sin enumeración: mismo 429 exista o no el email. Un
 * ADMIN desbloquea a un miembro de SU clínica (auditado).
 *
 * Política real por defecto (5 fallos libres, 1, 2, 4… min, tope 15) salvo el
 * balde por IP, que aquí se sube para aislar el de la cuenta (tiene su propio
 * bloque abajo). El paso del tiempo se simula moviendo `blockedUntil` en la
 * BD, como haría el reloj. Detrás de un proxy de confianza (1 salto) para
 * poder variar la IP con X-Forwarded-For.
 */
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const RUN = Date.now().toString(36);
const CLINIC_IP = '198.51.100.10';
const WRONG = 'Mala-clave-1';

function lockoutApp(
  cfg: Partial<LoginLockoutConfig>,
): Promise<INestApplication<App>> {
  return createE2eApp({
    securitySettings: {
      ...loadSecuritySettings((k) => process.env[k]),
      trustProxyHops: 1,
    },
    override: (builder) => {
      builder
        .overrideProvider(LOGIN_LOCKOUT_CONFIG)
        .useValue({ ...DEFAULT_LOGIN_LOCKOUT, ...cfg });
    },
  });
}

/** Lo que haría el reloj: la espera vigente de la cuenta ya pasó. */
async function expireAccountWait(email: string): Promise<void> {
  await raw.loginThrottle.updateMany({
    where: { scope: 'ACCOUNT', keyHash: accountKeyHash(email) },
    data: { blockedUntil: new Date(Date.now() - 1000) },
  });
}

async function clearThrottles(): Promise<void> {
  await raw.loginThrottle.deleteMany({});
}

function expectLocked(res: request.Response, maxSeconds: number): number {
  expect(res.status).toBe(429);
  const retryAfter = Number(res.headers['retry-after']);
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(maxSeconds);
  expect(res.body).toEqual({
    statusCode: 429,
    error: 'Too Many Requests',
    message: `Demasiados intentos. Vuelve a intentarlo en ${Math.ceil(retryAfter / 60)} min.`,
  });
  return retryAfter;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

describe('Bloqueo del login por fallos (DX-048, e2e)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let doctora: { userId: string; email: string };
  let recepcion: { userId: string; email: string };
  let dentistaB: { userId: string; email: string };

  const login = (
    email: string,
    password: string,
    ip = CLINIC_IP,
    host = clinicA.host,
  ) =>
    request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', host)
      .set('X-Forwarded-For', ip)
      .send({ email, password });

  beforeAll(async () => {
    app = await lockoutApp({ ipFailureLimit: 100_000 });
    clinicA = await registerClinic(app, `lock-a-${RUN}`);
    clinicB = await registerClinic(app, `lock-b-${RUN}`);
    doctora = await seedMember(raw, clinicA, ClinicRole.DENTIST);
    recepcion = await seedMember(raw, clinicA, ClinicRole.RECEPTION);
    dentistaB = await seedMember(raw, clinicB, ClinicRole.DENTIST);
  });

  beforeEach(clearThrottles);

  afterAll(async () => {
    await clearThrottles();
    await app.close();
    await raw.$disconnect();
  });

  it('10 logins correctos seguidos del mismo usuario desde la misma IP nunca dan 429', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await login(doctora.email, SEEDED_PASSWORD);
      expect(res.status).toBe(201);
    }
    expect(await raw.loginThrottle.count({ where: { scope: 'ACCOUNT' } })).toBe(
      0,
    );
  });

  it('tras 5 fallos el siguiente intento espera (429 + Retry-After), aunque traiga la contraseña buena', async () => {
    for (let i = 0; i < 4; i++) {
      expect((await login(doctora.email, WRONG)).status).toBe(401);
    }
    expect((await login(doctora.email, WRONG)).status).toBe(401);
    const res = await login(doctora.email, SEEDED_PASSWORD);
    expectLocked(res, 60);
    // Solo Retry-After: ninguna cabecera X-RateLimit-* de la librería.
    expect(
      Object.keys(res.headers).filter((h) => h.startsWith('x-ratelimit')),
    ).toEqual([]);
    // Otra cuenta de la misma clínica (misma IP por NAT) entra sin problema.
    expect((await login(recepcion.email, SEEDED_PASSWORD)).status).toBe(201);
    // El contador se guarda por hash: ni el email ni la IP en claro.
    const rows = await raw.$queryRaw<{ row: string }[]>`
      SELECT row_to_json(t)::text AS row FROM "login_throttles" t`;
    const dump = rows.map((r) => r.row).join(' ');
    expect(dump).not.toContain(doctora.email);
    expect(dump).not.toContain(CLINIC_IP);
  });

  it('el backoff crece (1, 2, 4… min) y nunca pasa de 15 min', async () => {
    for (let i = 0; i < 5; i++) await login(doctora.email, WRONG);
    const waits: number[] = [];
    for (let round = 0; round < 6; round++) {
      waits.push(expectLocked(await login(doctora.email, WRONG), 900));
      await expireAccountWait(doctora.email);
      expect((await login(doctora.email, WRONG)).status).toBe(401);
    }
    waits.push(expectLocked(await login(doctora.email, WRONG), 900));
    const minutes = waits.map((s) => Math.ceil(s / 60));
    expect(minutes).toEqual([1, 2, 4, 8, 15, 15, 15]);
  });

  it('sin enumeración: mismo 401 y mismo 429 (cuerpo y Retry-After) exista o no el email, sin diferencia de tiempo apreciable', async () => {
    const ghost = `nadie-${RUN}@lock-a.test`;
    for (let i = 0; i < 5; i++) {
      const [real, fake] = await Promise.all([
        login(doctora.email, WRONG),
        login(ghost, WRONG),
      ]);
      expect(real.status).toBe(401);
      expect(fake.status).toBe(401);
      expect(fake.body).toEqual(real.body);
    }
    const real = await login(doctora.email, WRONG);
    const fake = await login(ghost, WRONG);
    expectLocked(real, 60);
    expectLocked(fake, 60);
    expect(fake.body).toEqual(real.body);
    expect(
      Math.abs(
        Number(real.headers['retry-after']) -
          Number(fake.headers['retry-after']),
      ),
    ).toBeLessThanOrEqual(1);

    // Tiempo del 429: el mismo camino (una lectura por hash, sin argon2 ni
    // buscar al usuario) para los dos.
    const time = async (email: string): Promise<number> => {
      const t0 = performance.now();
      const res = await login(email, SEEDED_PASSWORD);
      expect(res.status).toBe(429);
      return performance.now() - t0;
    };
    const realTimes: number[] = [];
    const fakeTimes: number[] = [];
    for (let i = 0; i < 15; i++) {
      realTimes.push(await time(doctora.email));
      fakeTimes.push(await time(ghost));
    }
    expect(Math.abs(median(realTimes) - median(fakeTimes))).toBeLessThan(25);
  });

  it('un login correcto reinicia el contador de fallos (fuera de la espera)', async () => {
    for (let i = 0; i < 4; i++) await login(doctora.email, WRONG);
    expect((await login(doctora.email, SEEDED_PASSWORD)).status).toBe(201);
    // Vuelve a tener 4 fallos libres: el 5.º intento aún es un 401.
    for (let i = 0; i < 4; i++) {
      expect((await login(doctora.email, WRONG)).status).toBe(401);
    }
    expect((await login(doctora.email, WRONG)).status).toBe(401);
    expectLocked(await login(doctora.email, SEEDED_PASSWORD), 60);
    // Pasada la espera, el acierto entra y borra el contador.
    await expireAccountWait(doctora.email);
    expect((await login(doctora.email, SEEDED_PASSWORD)).status).toBe(201);
    expect(
      await raw.loginThrottle.count({
        where: { scope: 'ACCOUNT', keyHash: accountKeyHash(doctora.email) },
      }),
    ).toBe(0);
  });

  it('un atacante que falla con el email de la doctora desde varias IPs no la deja fuera más allá del backoff', async () => {
    for (let i = 0; i < 12; i++) {
      await expireAccountWait(doctora.email);
      expect(
        (await login(doctora.email, WRONG, `203.0.113.${i + 1}`)).status,
      ).toBe(401);
    }
    // Desde su IP espera, pero nunca más del tope (15 min), no 1 h.
    expectLocked(await login(doctora.email, SEEDED_PASSWORD), 15 * 60);
    await expireAccountWait(doctora.email);
    expect((await login(doctora.email, SEEDED_PASSWORD)).status).toBe(201);
  });

  it('el contador es por cuenta: el mismo email con otra capitalización comparte espera', async () => {
    for (let i = 0; i < 5; i++) {
      await login(doctora.email.toUpperCase(), WRONG);
    }
    const capitalized = doctora.email[0].toUpperCase() + doctora.email.slice(1);
    expectLocked(await login(capitalized, SEEDED_PASSWORD), 60);
  });

  describe('desbloqueo por un ADMIN', () => {
    let adminA: string;
    let adminB: string;

    async function lockDoctora(): Promise<void> {
      for (let i = 0; i < 5; i++) await login(doctora.email, WRONG);
      expectLocked(await login(doctora.email, SEEDED_PASSWORD), 60);
    }

    const unlock = (token: string, userId: string) =>
      request(app.getHttpServer())
        .post(`/api/v1/staff/${userId}/login-unlock`)
        .set('X-Tenant-Host', clinicA.host)
        .set('Authorization', `Bearer ${token}`);

    beforeAll(() => {
      adminA = clinicA.adminToken;
      adminB = clinicB.adminToken;
    });

    it('el perfil muestra el bloqueo, el ADMIN lo quita, queda auditado y la doctora entra', async () => {
      await lockDoctora();
      const before = await request(app.getHttpServer())
        .get(`/api/v1/staff/${doctora.userId}`)
        .set('X-Tenant-Host', clinicA.host)
        .set('Authorization', `Bearer ${adminA}`)
        .expect(200);
      const blockedUntil = new Date(
        (before.body as { loginBlockedUntil: string }).loginBlockedUntil,
      );
      expect(blockedUntil.getTime()).toBeGreaterThan(Date.now());

      await unlock(adminA, doctora.userId).expect(204);

      const after = await request(app.getHttpServer())
        .get(`/api/v1/staff/${doctora.userId}`)
        .set('X-Tenant-Host', clinicA.host)
        .set('Authorization', `Bearer ${adminA}`)
        .expect(200);
      expect(after.body).toMatchObject({ loginBlockedUntil: null });
      expect((await login(doctora.email, SEEDED_PASSWORD)).status).toBe(201);

      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: clinicA.tenantId,
          action: 'UPDATE',
          resourceType: 'STAFF_MEMBER',
          resourceId: doctora.userId,
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorUserId: clinicA.adminUserId,
        actorRole: 'ADMIN',
        metadata: { reason: 'LOGIN_UNLOCKED' },
      });
    });

    it('es idempotente: desbloquear a quien no está bloqueado da 204', async () => {
      await unlock(adminA, recepcion.userId).expect(204);
    });

    it('un ADMIN de otra clínica no puede desbloquear (404) y la doctora sigue en espera', async () => {
      await lockDoctora();
      await request(app.getHttpServer())
        .post(`/api/v1/staff/${doctora.userId}/login-unlock`)
        .set('X-Tenant-Host', clinicB.host)
        .set('Authorization', `Bearer ${adminB}`)
        .expect(404);
      expectLocked(await login(doctora.email, SEEDED_PASSWORD), 60);
      // Ni con su token contra el host de la clínica A (no es su clínica).
      const crossHost = await unlock(adminB, doctora.userId);
      expect([401, 403, 404]).toContain(crossHost.status);
      expectLocked(await login(doctora.email, SEEDED_PASSWORD), 60);
      const unlockedFromB = await raw.auditEvent.count({
        where: { tenantId: clinicB.tenantId, resourceType: 'STAFF_MEMBER' },
      });
      expect(unlockedFromB).toBe(0);
    });

    it('un usuario que no es ADMIN recibe 403', async () => {
      const recepToken = await loginAs(app, clinicA.host, recepcion.email);
      await unlock(recepToken, doctora.userId).expect(403);
      const dentistB = await loginAs(app, clinicB.host, dentistaB.email);
      await request(app.getHttpServer())
        .post(`/api/v1/staff/${doctora.userId}/login-unlock`)
        .set('X-Tenant-Host', clinicB.host)
        .set('Authorization', `Bearer ${dentistB}`)
        .expect(403);
    });

    it('un userId que no es UUID da 400', async () => {
      await unlock(adminA, 'no-es-uuid').expect(400);
    });
  });
});

describe('Balde por IP del login (DX-048, e2e)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  const IP_LIMIT = 4;

  const login = (email: string, password: string, ip: string) =>
    request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', clinic.host)
      .set('X-Forwarded-For', ip)
      .send({ email, password });

  beforeAll(async () => {
    await clearThrottles();
    app = await lockoutApp({ ipFailureLimit: IP_LIMIT, ipWindowMs: 60_000 });
    clinic = await registerClinic(app, `lock-ip-${RUN}`);
  });

  afterAll(async () => {
    await clearThrottles();
    await app.close();
  });

  it('solo cuenta los fallos: los aciertos desde la IP de la clínica no la bloquean', async () => {
    const owner = `owner@${clinic.subdomain}.test`;
    for (let i = 0; i < IP_LIMIT * 3; i++) {
      expect((await login(owner, SEEDED_PASSWORD, '192.0.2.50')).status).toBe(
        201,
      );
    }
  });

  it('muchos emails desde una IP ("spraying") acaban en 429 para esa IP, no para las demás', async () => {
    const ip = '192.0.2.77';
    for (let i = 0; i < IP_LIMIT; i++) {
      expect((await login(`spray${i}-${RUN}@x.test`, WRONG, ip)).status).toBe(
        401,
      );
    }
    const res = await login(`otro-${RUN}@x.test`, WRONG, ip);
    expectLocked(res, 60);
    // La clínica que sale por otra IP sigue entrando.
    expect(
      (
        await login(
          `owner@${clinic.subdomain}.test`,
          SEEDED_PASSWORD,
          '192.0.2.50',
        )
      ).status,
    ).toBe(201);
  });
});
