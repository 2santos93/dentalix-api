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
  REGIONAL_BERLIN_FIXTURE,
  REGIONAL_BOGOTA_FIXTURE,
  REGIONAL_NEW_YORK_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
  registerBody as clinicRegisterBody,
} from './support/location-fixtures';
import { PasswordService } from '../src/shared/crypto/password.service';
import { PLATFORM_DEFAULT_MAJORITY_AGE } from '../src/modules/patients/domain/responsible-parties/majority-age';
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

  it('a registered clinic is created with majorityAge 18', async () => {
    const register = await registerVerified(
      app,
      clinicRegisterBody(REGIONAL_BOGOTA_FIXTURE, {
        clinicName: 'Mayoría',
        subdomain: 'dx328-registro',
        email: 'owner@dx328-registro.com',
        password: 'S3cret!!',
        fullName: 'Dr. Owner',
      }),
    );
    const { tenantId } = register.body as RegisterResponseBody;
    const tenant = await raw.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { majorityAge: true },
    });
    expect(tenant.majorityAge).toBe(PLATFORM_DEFAULT_MAJORITY_AGE);
    expect(PLATFORM_DEFAULT_MAJORITY_AGE).toBe(18);
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

  // GLOBAL-G1 (spec §3.5): la primera sede se elige al registrarse. La forma
  // legada (web antigua sin sede) es 400 y su enlace pendiente responde 410
  // sin consumirse (DX-312, R7).
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

    it('legacy registration without location fields is 400 with field locationCountry', async () => {
      const legacy = base('g1-web-antigua');
      const res = await api()
        .post('/api/v1/auth/register')
        .set('X-Tenant-Host', 'localhost')
        .send(legacy)
        .expect(400);
      expect(res.body).toMatchObject({
        message: 'Elige el país de la sede.',
        field: 'locationCountry',
      });
      expect(
        await raw.pendingRegistration.count({ where: { email: legacy.email } }),
      ).toBe(0);
    });

    it('legacy pending without location answers 410 and creates nothing', async () => {
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
      expect(res.status).toBe(410);
      expect((res.body as { message: string }).message).toMatch(/caducó/);
      // El pendiente sigue, y no se creó ni la clínica ni el dueño.
      expect(
        await raw.pendingRegistration.count({ where: { email: old.email } }),
      ).toBe(1);
      expect(
        await raw.tenant.count({ where: { subdomain: old.subdomain } }),
      ).toBe(0);
      expect(await raw.user.count({ where: { email: old.email } })).toBe(0);
    });

    it('registration with the five fields creates the location with them', async () => {
      const { body } = await registerVerified(
        app,
        clinicRegisterBody(REGIONAL_NEW_YORK_FIXTURE, base('g1b-cinco')),
      );
      const location = await mainLocation(body.tenantId);
      expect(location).toMatchObject({
        currency: 'USD',
        timeZone: 'America/New_York',
        locale: 'en-US',
        hourCycle: 'h12',
      });
      expect(location.regionalSettingsReviewedAt).not.toBeNull();
    });

    it('G1-shape registration verify creates the location with the backfilled clock', async () => {
      // La web de G1 envía los cuatro y no el reloj: se acepta, y verify crea
      // la sede con lo elegido y el reloj de la función (pre-flight I3).
      const g1 = clinicRegisterBody(
        REGIONAL_BERLIN_FIXTURE,
        base('g1b-web-g1'),
      );
      const { locationHourCycle: _omitted, ...g1Body } = g1;
      await api()
        .post('/api/v1/auth/register')
        .set('X-Tenant-Host', 'localhost')
        .send(g1Body)
        .expect(202);
      await waitForPending(g1.email);
      const pending = await raw.pendingRegistration.findFirstOrThrow({
        where: { email: g1.email },
      });
      expect(pending.locationHourCycle).toBeNull();
      const res = await verifyPending(g1.email);
      expect(res.status).toBe(201);
      const location = await mainLocation(
        (res.body as { tenantId: string }).tenantId,
      );
      expect(location).toMatchObject({
        currency: 'EUR',
        timeZone: 'Europe/Berlin',
        locale: 'de-DE',
        hourCycle: 'h23',
      });
      expect(location.regionalSettingsReviewedAt).not.toBeNull();
    });

    it('G1-shape registration verify keeps the chosen currency, zone and format', async () => {
      // Lo que deja una réplica de G1: un pendiente con los cuatro y sin
      // reloj. No es legado: la función D5 de G1 no debe pisar lo elegido.
      const g1 = base('g1b-replica-g1');
      await raw.pendingRegistration.create({
        data: {
          email: g1.email,
          clinicName: g1.clinicName,
          subdomain: g1.subdomain,
          fullName: g1.fullName,
          passwordHash: await new PasswordService().hash(PASSWORD),
          tokenHash: hashRegistrationToken(generateRegistrationToken()),
          expiresAt: registrationExpiresAt(new Date()),
          locationCountry: REGIONAL_TOKYO_FIXTURE.country,
          locationCurrency: REGIONAL_TOKYO_FIXTURE.currency,
          locationTimeZone: REGIONAL_TOKYO_FIXTURE.timeZone,
          locationLocale: REGIONAL_TOKYO_FIXTURE.locale,
        },
      });
      const res = await verifyPending(g1.email);
      expect(res.status).toBe(201);
      const location = await mainLocation(
        (res.body as { tenantId: string }).tenantId,
      );
      expect(location).toMatchObject({
        currency: 'JPY',
        timeZone: 'Asia/Tokyo',
        locale: 'ja-JP',
        hourCycle: 'h23',
      });
      expect(location.regionalSettingsReviewedAt).not.toBeNull();
      expect(await legacyScheduleZone(location.id)).toBe('Asia/Tokyo');
    });

    it('locationHourCycle alone is 400', async () => {
      const alone = base('g1b-solo-reloj');
      const res = await api()
        .post('/api/v1/auth/register')
        .set('X-Tenant-Host', 'localhost')
        .send({ ...alone, locationHourCycle: 'h12' })
        .expect(400);
      expect(res.body).toMatchObject({
        message: 'Elige el país de la sede.',
        field: 'locationCountry',
      });
      const invalid = await api()
        .post('/api/v1/auth/register')
        .set('X-Tenant-Host', 'localhost')
        .send(
          clinicRegisterBody(REGIONAL_NEW_YORK_FIXTURE, {
            ...alone,
            locationHourCycle: 'h24',
          }),
        )
        .expect(400);
      expect(invalid.body).toMatchObject({
        message: 'El reloj «h24» no es válido: elige 12 h o 24 h.',
        field: 'locationHourCycle',
      });
      expect(
        await raw.pendingRegistration.count({ where: { email: alone.email } }),
      ).toBe(0);
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
