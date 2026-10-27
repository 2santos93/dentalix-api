import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_BOGOTA_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
  registerBody as clinicRegisterBody,
} from './support/location-fixtures';
import { PasswordService } from '../src/shared/crypto/password.service';
import {
  generateRegistrationToken,
  hashRegistrationToken,
  registrationExpiresAt,
} from '../src/modules/auth/application/registration-token';

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para el cleanup en beforeAll —
// usa DIRECT_URL (rol owner `dentalix`, superuser) porque, con RLS aplicado, una
// conexión sin contexto de tenant (rol dentalix_app vía DATABASE_URL) ve 0 filas
// en clinic_memberships y no podría limpiar datos de corridas anteriores; borrar
// solo users/tenants entonces fallaría por FK RESTRICT desde memberships huérfanas.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface RegisterResponseBody {
  tenantId: string;
  userId: string;
}

interface LoginResponseBody {
  accessToken: string;
  refreshToken: string;
}

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    await app.listen(0, '127.0.0.1');
    await resetDatabase(raw);
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('registers a clinic and logs the owner in', async () => {
    const register = await registerVerified(
      app,
      clinicRegisterBody(REGIONAL_BOGOTA_FIXTURE, {
        clinicName: 'Sonrisa',
        subdomain: 'sonrisa',
        email: 'owner@sonrisa.com',
        password: 'S3cret!!',
        fullName: 'Dr. Owner',
      }),
    );
    const registerBody = register.body as RegisterResponseBody;
    expect(registerBody.tenantId).toBeDefined();

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor('sonrisa'))
      .send({
        email: 'owner@sonrisa.com',
        password: 'S3cret!!',
      })
      .expect(201);
    const loginBody = login.body as LoginResponseBody;
    expect(loginBody.accessToken).toBeDefined();
    expect(loginBody.refreshToken).toBeDefined();
  });

  it('rejects login with a wrong password', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor('sonrisa'))
      .send({
        email: 'owner@sonrisa.com',
        password: 'nope',
      })
      .expect(401);
  });

  it('rejects login when the host resolves to no tenant', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor('does-not-exist'))
      .send({ email: 'owner@sonrisa.com', password: 'S3cret!!' })
      .expect(401);
  });

  it('sets up a clinic and confirms refresh works before logout', async () => {
    // Nueva clínica aislada para no chocar con los otros tests.
    await registerVerified(
      app,
      clinicRegisterBody(REGIONAL_BOGOTA_FIXTURE, {
        clinicName: 'Muela',
        subdomain: 'muela',
        email: 'owner@muela.com',
        password: 'S3cret!!',
        fullName: 'Dra. Muela',
      }),
    );

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor('muela'))
      .send({ email: 'owner@muela.com', password: 'S3cret!!' })
      .expect(201);
    const { refreshToken } = login.body as LoginResponseBody;

    // Antes del logout, el refresh funciona.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(201);
  });

  it('rejects refresh after logout and stays 204 on repeat logout', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor('muela'))
      .send({ email: 'owner@muela.com', password: 'S3cret!!' })
      .expect(201);
    const { refreshToken } = login.body as LoginResponseBody;

    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken })
      .expect(204);

    // El refresh revocado ahora es 401.
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);

    // Logout repetido con el mismo token sigue siendo 204 (idempotente).
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken })
      .expect(204);
  });

  // GLOBAL-G1 (spec §3.5): la primera sede se elige al registrarse. Fase 1:
  // una web antigua (sin los cuatro campos) y un enlace de una réplica
  // antigua siguen funcionando; la sede queda rellenada por la función D5 y
  // «por revisar».
  describe('registro con la primera sede (G1)', () => {
    const api = () => request(app.getHttpServer());
    const PASSWORD = 'S3cret!!';
    const base = (subdomain: string) => ({
      clinicName: `Clínica ${subdomain}`,
      subdomain,
      email: `owner@${subdomain}.test`,
      password: PASSWORD,
      fullName: 'Dra. Dueña',
    });
    const mainLocation = (tenantId: string) =>
      raw.location.findFirstOrThrow({ where: { tenantId } });
    const legacyScheduleZone = async (locationId: string) =>
      (
        await raw.locationSchedule.findFirstOrThrow({
          where: { locationId, deletedAt: null },
          select: { timezone: true },
        })
      ).timezone;

    /** Verifica un pendiente fijando el hash de un token propio (como registerVerified). */
    async function verifyPending(email: string) {
      const token = generateRegistrationToken();
      const { count } = await raw.pendingRegistration.updateMany({
        where: { email },
        data: { tokenHash: hashRegistrationToken(token) },
      });
      expect(count).toBe(1);
      return api()
        .post('/api/v1/auth/register/verify')
        .send({ token, password: PASSWORD });
    }

    async function waitForPending(email: string) {
      for (let i = 0; i < 200; i++) {
        if (await raw.pendingRegistration.count({ where: { email } })) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('no apareció el registro pendiente');
    }

    it('registration creates the location with the four values, reviewed', async () => {
      const before = Date.now();
      const { body } = await registerVerified(
        app,
        clinicRegisterBody(REGIONAL_TOKYO_FIXTURE, {
          ...base('g1-tokio'),
          locationCurrency: 'jpy',
          locationLocale: 'JA-jp',
        }),
      );
      const location = await mainLocation(body.tenantId);
      expect(location).toMatchObject({
        name: 'Sede principal',
        country: 'CO',
        currency: 'JPY',
        timeZone: 'Asia/Tokyo',
        locale: 'ja-JP',
      });
      expect(
        location.regionalSettingsReviewedAt!.getTime(),
      ).toBeGreaterThanOrEqual(before - 1000);
      // R20: la columna legada del horario nace igual a la zona de la sede.
      expect(await legacyScheduleZone(location.id)).toBe('Asia/Tokyo');
    });

    it('registration with a subset of the fields is 400', async () => {
      const subset = base('g1-subset');
      const res = await api()
        .post('/api/v1/auth/register')
        .set('X-Tenant-Host', 'localhost')
        .send({
          ...subset,
          locationCurrency: 'JPY',
          locationTimeZone: 'Asia/Tokyo',
        })
        .expect(400);
      expect(res.body).toMatchObject({
        message: 'Elige el país de la sede.',
        field: 'locationCountry',
      });
      const noZone = await api()
        .post('/api/v1/auth/register')
        .set('X-Tenant-Host', 'localhost')
        .send({
          ...subset,
          locationCountry: 'CO',
          locationCurrency: 'JPY',
          locationLocale: 'ja-JP',
        })
        .expect(400);
      expect(noZone.body).toMatchObject({
        message: 'Elige la zona horaria de la sede.',
        field: 'locationTimeZone',
      });
      expect(
        await raw.pendingRegistration.count({
          where: { email: subset.email },
        }),
      ).toBe(0);
    });

    it('registration without the four (legacy shape) is 201', async () => {
      const legacy = base('g1-web-antigua');
      await api()
        .post('/api/v1/auth/register')
        .set('X-Tenant-Host', 'localhost')
        .send(legacy)
        .expect(202);
      await waitForPending(legacy.email);
      const res = await verifyPending(legacy.email);
      expect(res.status).toBe(201);
      const location = await mainLocation(
        (res.body as { tenantId: string }).tenantId,
      );
      expect(location).toMatchObject({
        country: 'CO',
        currency: 'COP',
        timeZone: 'America/Bogota',
        locale: 'es-CO',
        regionalSettingsReviewedAt: null,
      });
    });

    it('legacy pending verify creates the clinic and backfills it unreviewed', async () => {
      // Lo que deja una réplica anterior a G1: un pendiente sin columnas de sede.
      const old = base('g1-replica-antigua');
      await raw.pendingRegistration.create({
        data: {
          email: old.email,
          clinicName: old.clinicName,
          subdomain: old.subdomain,
          fullName: old.fullName,
          passwordHash: await new PasswordService().hash(PASSWORD),
          tokenHash: hashRegistrationToken(generateRegistrationToken()),
          expiresAt: registrationExpiresAt(new Date()),
        },
      });
      const res = await verifyPending(old.email);
      expect(res.status).toBe(201);
      const { tenantId } = res.body as { tenantId: string };
      const location = await mainLocation(tenantId);
      expect(location).toMatchObject({
        name: 'Sede principal',
        country: 'CO',
        currency: 'COP',
        timeZone: 'America/Bogota',
        locale: 'es-CO',
        // Por revisar: el ADMIN verá el aviso D5.
        regionalSettingsReviewedAt: null,
      });
      expect(await legacyScheduleZone(location.id)).toBe('America/Bogota');
      // El enlace se consumió y el dueño puede entrar.
      expect(
        await raw.pendingRegistration.count({ where: { email: old.email } }),
      ).toBe(0);
      await api()
        .post('/api/v1/auth/login')
        .set('X-Tenant-Host', hostFor(old.subdomain))
        .send({ email: old.email, password: PASSWORD })
        .expect(201);
    });

    it('anonymous GET /public/currencies is 200', async () => {
      const res = await api()
        .get('/api/v1/public/currencies')
        .set('X-Tenant-Host', 'localhost')
        .expect(200);
      const codes = (res.body as { code: string }[]).map((c) => c.code);
      expect(codes).toEqual(expect.arrayContaining(['COP', 'EUR', 'JPY']));
      expect(codes).not.toContain('KWD');
      expect(res.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'JPY',
            name: expect.any(String) as string,
          }),
        ]),
      );
    });
  });
});
