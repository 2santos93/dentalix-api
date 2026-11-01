import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationBody,
  registerBody,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';

// SEC-001 / SEC-002: el refresh revalida la sesión contra el estado ACTUAL
// (membresía, rol, usuario, superadmin), es de un solo uso (rotación real) y
// cambiar la contraseña invalida las sesiones previas.
//
// `raw` (DIRECT_URL, superuser) solo siembra y limpia — mismo patrón que
// staff.e2e-spec.ts. La limpieza es acotada a lo que crea este archivo.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
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
  await purgeTenantsBySubdomain(raw, [SUB]);
  await raw.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
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
    await app.listen(0, '127.0.0.1');
    await cleanup();

    const reg = await registerVerified(
      app,
      registerBody(REGIONAL_BOGOTA_FIXTURE, {
        clinicName: 'Sesiones E2E',
        subdomain: SUB,
        email: OWNER,
        password: PASSWORD,
        fullName: 'Dra. Dueña',
      }),
    );
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

  it('DX-089: restringir las sedes se aplica en el siguiente refresh (claim `loc`) y una sede no permitida da 403', async () => {
    const member = await seedMember('recepcion-sede', ClinicRole.RECEPTION);
    const before = await login(member.email);
    // Sin filas en membership_locations: todas las sedes, sin claim.
    expect(claimsOf(before.accessToken)).not.toHaveProperty('loc');

    const principal = await raw.location.findFirstOrThrow({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const norte = await http()
      .post('/api/v1/locations')
      .set('X-Tenant-Host', hostFor(SUB))
      .set('Authorization', `Bearer ${ownerAccess}`)
      .send(locationBody(REGIONAL_BOGOTA_FIXTURE, { name: 'Sede Norte' }))
      .expect(201);
    const otherLocationId = (norte.body as { id: string }).id;

    const membership = await raw.clinicMembership.findFirstOrThrow({
      where: { tenantId, userId: member.userId },
      select: { id: true },
    });
    await raw.membershipLocation.create({
      data: {
        tenantId,
        membershipId: membership.id,
        locationId: principal.id,
      },
    });

    // El access vigente no cambia hasta renovar…
    expect(claimsOf(before.accessToken)).not.toHaveProperty('loc');
    // …y el par renovado ya lleva la restricción vigente.
    const res = await refresh(before.refreshToken).expect(201);
    const renewed = res.body as Tokens;
    expect(claimsOf(renewed.accessToken).loc).toEqual([principal.id]);
    expect(claimsOf(renewed.refreshToken).loc).toEqual([principal.id]);

    const range = {
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-08T00:00:00.000Z',
    };
    const forbidden = await http()
      .get('/api/v1/appointments')
      .query(range)
      .set('X-Tenant-Host', hostFor(SUB))
      .set('X-Location-Id', otherLocationId)
      .set('Authorization', `Bearer ${renewed.accessToken}`)
      .expect(403);
    expect(forbidden.body).toMatchObject({
      statusCode: 403,
      code: 'LOCATION_NOT_ALLOWED',
      message: 'No tienes acceso a esta sede.',
    });

    await http()
      .get('/api/v1/appointments')
      .query(range)
      .set('X-Tenant-Host', hostFor(SUB))
      .set('X-Location-Id', principal.id)
      .set('Authorization', `Bearer ${renewed.accessToken}`)
      .expect(200);
  });

  /** Lleva la última rotación de la familia del token fuera de la gracia. */
  async function ageLastRotation(refreshToken: string): Promise<void> {
    const sid = claimsOf(refreshToken).sid as string;
    await raw.refreshSession.update({
      where: { id: sid },
      data: { rotatedAt: new Date(Date.now() - 5 * 60_000) },
    });
  }

  it('a refresh token is single-use: reusing it after the grace is 401 and revokes the WHOLE family (theft detection)', async () => {
    const { refreshToken } = await login(OWNER);

    const first = await refresh(refreshToken).expect(201);
    const next = (first.body as Tokens).refreshToken;
    await ageLastRotation(next);

    // Alguien presenta el token ya rotado fuera de la gracia: 401…
    await refresh(refreshToken).expect(401);
    // …y la cadena del que rotó primero también muere: ladrón y víctima
    // vuelven a /login en vez de quedar viva la cadena robada.
    await refresh(next).expect(401);
  });

  it('lost response: the PREVIOUS token within the grace gets the CURRENT one again (same jti), not a second chain', async () => {
    const { refreshToken } = await login(OWNER);

    // La API rota pero el cliente no recibe la respuesta (recarga, red).
    const lost = ((await refresh(refreshToken).expect(201)).body as Tokens)
      .refreshToken;
    // Reintenta con el token que aún tiene: 201 con una copia del vigente.
    const again = ((await refresh(refreshToken).expect(201)).body as Tokens)
      .refreshToken;
    expect(claimsOf(again).jti).toBe(claimsOf(lost).jti);
    expect(claimsOf(again).exp).toBe(claimsOf(lost).exp);
    expect(claimsOf(again).sid).toBe(claimsOf(refreshToken).sid);

    // Una sola cadena: la copia rota y, desde ahí, el token del login es
    // más viejo que el anterior → reuso.
    const third = ((await refresh(again).expect(201)).body as Tokens)
      .refreshToken;
    await refresh(refreshToken).expect(401);
    await refresh(third).expect(401);
  });

  it('two concurrent refreshes with the same token yield ONE live chain (every copy carries the same jti)', async () => {
    const { refreshToken } = await login(OWNER);

    const results = await Promise.all([
      refresh(refreshToken),
      refresh(refreshToken),
      refresh(refreshToken),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    const jtis = new Set(
      results.map((r) => claimsOf((r.body as Tokens).refreshToken).jti),
    );
    expect(jtis.size).toBe(1);
    // Sin gracia (fuera de ella), el token original ya no sirve.
    await ageLastRotation((results[0].body as Tokens).refreshToken);
    await refresh(refreshToken).expect(401);
  });

  it('a pre-family refresh (no sid claim) is still single-use by the denylist and its new pair joins a family', async () => {
    const { refreshToken } = await login(OWNER);
    // Un refresh emitido antes de las familias: mismos claims, sin `sid`.
    const { sid: _sid, iat: _iat, ...legacyClaims } = claimsOf(refreshToken);
    const legacy = await new JwtService({}).signAsync(legacyClaims, {
      secret: process.env.JWT_REFRESH_SECRET,
    });

    const renewed = ((await refresh(legacy).expect(201)).body as Tokens)
      .refreshToken;
    await refresh(legacy).expect(401);
    expect(typeof claimsOf(renewed).sid).toBe('string');
    await refresh(renewed).expect(201);
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
