import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';

// SEC-001 / SEC-002: el refresh revalida la sesión contra el estado ACTUAL
// (membresía, rol, usuario, superadmin), es de un solo uso (rotación real) y
// cambiar la contraseña invalida las sesiones previas.
//
// `raw` (DIRECT_URL, superuser) solo siembra y limpia — mismo patrón que
// staff.e2e-spec.ts. La limpieza es acotada a lo que crea este archivo.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const passwordService = new PasswordService();
const PASSWORD = 'S3cret!!';
const SUB = 'sesiones-e2e';
const DOMAIN = '@sesiones-e2e.com';
const OWNER = `owner${DOMAIN}`;

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

function claimsOf(jwt: string): Record<string, unknown> {
  const [, body] = jwt.split('.');
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

async function cleanup(): Promise<void> {
  await raw.clinicMembership.deleteMany({
    where: { user: { email: { endsWith: DOMAIN } } },
  });
  await raw.clinicMembership.deleteMany({
    where: { tenant: { subdomain: SUB } },
  });
  await raw.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await raw.tenant.deleteMany({ where: { subdomain: SUB } });
}

describe('Session revalidation on refresh (e2e)', () => {
  let app: INestApplication<App>;
  let tenantId: string;
  let ownerAccess: string;

  const http = () => request(app.getHttpServer());

  async function login(email: string, password = PASSWORD): Promise<Tokens> {
    const res = await http()
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(SUB))
      .send({ email, password })
      .expect(201);
    return res.body as Tokens;
  }

  async function seedMember(
    local: string,
    role: ClinicRole,
  ): Promise<{ userId: string; email: string }> {
    const email = `${local}${DOMAIN}`;
    const user = await raw.user.create({
      data: {
        email,
        passwordHash: await passwordService.hash(PASSWORD),
        fullName: local,
      },
      select: { id: true },
    });
    await raw.clinicMembership.create({
      data: { tenantId, userId: user.id, role },
    });
    return { userId: user.id, email };
  }

  function refresh(refreshToken: string) {
    return http().post('/api/v1/auth/refresh').send({ refreshToken });
  }

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
    await cleanup();

    const reg = await registerVerified(app, {
      clinicName: 'Sesiones E2E',
      subdomain: SUB,
      email: OWNER,
      password: PASSWORD,
      fullName: 'Dra. Dueña',
    });
    tenantId = (reg.body as { tenantId: string }).tenantId;
    ownerAccess = (await login(OWNER)).accessToken;
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  it('a deactivated member can no longer refresh (401)', async () => {
    const member = await seedMember('recepcion', ClinicRole.RECEPTION);
    const { refreshToken } = await login(member.email);

    await http()
      .delete(`/api/v1/staff/${member.userId}`)
      .set('X-Tenant-Host', hostFor(SUB))
      .set('Authorization', `Bearer ${ownerAccess}`)
      .expect(204);

    await refresh(refreshToken).expect(401);
  });

  it('a downgraded member gets the NEW role on refresh', async () => {
    const member = await seedMember('ex-admin', ClinicRole.ADMIN);
    const { refreshToken } = await login(member.email);

    await http()
      .patch(`/api/v1/staff/${member.userId}`)
      .set('X-Tenant-Host', hostFor(SUB))
      .set('Authorization', `Bearer ${ownerAccess}`)
      .send({ role: ClinicRole.ASSISTANT })
      .expect(200);

    const res = await refresh(refreshToken).expect(201);
    const renewed = res.body as Tokens;
    expect(claimsOf(renewed.accessToken).role).toBe(ClinicRole.ASSISTANT);
    expect(claimsOf(renewed.refreshToken).role).toBe(ClinicRole.ASSISTANT);
  });

  it('a refresh token is single-use: the second refresh with it is 401', async () => {
    const { refreshToken } = await login(OWNER);

    const first = await refresh(refreshToken).expect(201);
    await refresh(refreshToken).expect(401);

    // La cadena sigue viva: el token NUEVO sí renueva.
    await refresh((first.body as Tokens).refreshToken).expect(201);
  });

  it('two concurrent refreshes with the same token yield exactly ONE valid pair', async () => {
    const { refreshToken } = await login(OWNER);

    const results = await Promise.all([
      refresh(refreshToken),
      refresh(refreshToken),
      refresh(refreshToken),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 401, 401]);
  });

  it('changing the password revokes previous sessions and hands back a fresh pair', async () => {
    const member = await seedMember('dentista', ClinicRole.DENTIST);
    const otherDevice = await login(member.email);
    const thisDevice = await login(member.email);

    const res = await http()
      .post('/api/v1/me/password')
      .set('Authorization', `Bearer ${thisDevice.accessToken}`)
      .send({ currentPassword: PASSWORD, newPassword: 'NuevaClave9!' })
      .expect(200);
    const fresh = res.body as Tokens;

    // Las sesiones previas (incluida la del propio dispositivo) mueren…
    await refresh(otherDevice.refreshToken).expect(401);
    await refresh(thisDevice.refreshToken).expect(401);
    // …y el par devuelto por el cambio de contraseña sí sigue renovando.
    expect(claimsOf(fresh.refreshToken).role).toBe(ClinicRole.DENTIST);
    await refresh(fresh.refreshToken).expect(201);
    // La contraseña nueva es la que vale para entrar.
    await login(member.email, 'NuevaClave9!');
  });

  it('a platform session dies once the user stops being platform admin', async () => {
    const admin = await seedMember('soporte', ClinicRole.ASSISTANT);
    await raw.user.update({
      where: { id: admin.userId },
      data: { isPlatformAdmin: true },
    });
    // Host apex (sin tenant) → login de plataforma.
    const res = await http()
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', 'localhost')
      .send({ email: admin.email, password: PASSWORD })
      .expect(201);
    const platform = res.body as Tokens;
    expect(claimsOf(platform.refreshToken).platform).toBe(true);

    const renewed = await refresh(platform.refreshToken).expect(201);

    await raw.user.update({
      where: { id: admin.userId },
      data: { isPlatformAdmin: false },
    });
    await refresh((renewed.body as Tokens).refreshToken).expect(401);
  });
});
