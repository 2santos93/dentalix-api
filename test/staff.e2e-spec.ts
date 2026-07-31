import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para seed/cleanup — usa
// DIRECT_URL (rol owner `dentalix`, superuser) porque, con RLS aplicado, una
// conexión sin contexto de tenant (rol dentalix_app vía DATABASE_URL) ve 0
// filas y no podría sembrar/limpiar datos ajenos al tenant. Mismo patrón que
// appointments.e2e-spec.ts / role-matrix.e2e-spec.ts.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const passwordService = new PasswordService();
const SEEDED_PASSWORD = 'S3cret!!';

interface RegisterResponseBody {
  tenantId: string;
  userId: string;
}

interface LoginResponseBody {
  accessToken: string;
  refreshToken: string;
}

interface StaffMemberResponseBody {
  userId: string;
  fullName: string;
  email: string;
  role: ClinicRole;
}

async function registerAndLogin(
  app: INestApplication<App>,
  opts: { clinicName: string; subdomain: string; email: string },
): Promise<{
  tenantId: string;
  userId: string;
  accessToken: string;
  subdomain: string;
}> {
  const register = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({
      clinicName: opts.clinicName,
      subdomain: opts.subdomain,
      email: opts.email,
      password: SEEDED_PASSWORD,
      fullName: 'Dr. Owner',
    })
    .expect(201);
  const registerBody = register.body as RegisterResponseBody;

  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Tenant-Host', hostFor(opts.subdomain))
    .send({
      email: opts.email,
      password: SEEDED_PASSWORD,
    })
    .expect(201);
  const loginBody = login.body as LoginResponseBody;

  return {
    tenantId: registerBody.tenantId,
    userId: registerBody.userId,
    accessToken: loginBody.accessToken,
    subdomain: opts.subdomain,
  };
}

// Siembra un usuario con contraseña hasheada igual que el registro, más su
// membresía en la clínica (tenant) dada, con el rol pedido. Usa el cliente
// `raw` (DIRECT_URL, superuser) porque bypassa RLS -- se usa aquí solo para
// sembrar un segundo actor ADMIN que luego se degrada (ver step 4a más abajo)
// para poder probar la regla de "último admin" sin confundirla con la de "no
// puedes desactivarte a ti mismo" (mismo patrón de seed que
// appointments.e2e-spec.ts / role-matrix.e2e-spec.ts).
async function seedRoledMember(
  tenantId: string,
  email: string,
  role: ClinicRole,
  fullName: string,
): Promise<{ userId: string }> {
  const passwordHash = await passwordService.hash(SEEDED_PASSWORD);
  const user = await raw.user.create({
    data: {
      email,
      passwordHash,
      fullName,
      emailVerifiedAt: new Date(),
    },
    select: { id: true },
  });
  await raw.clinicMembership.create({
    data: { tenantId, userId: user.id, role },
  });
  return { userId: user.id };
}

async function loginAs(
  app: INestApplication<App>,
  opts: { subdomain: string; email: string; password?: string },
): Promise<LoginResponseBody> {
  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Tenant-Host', hostFor(opts.subdomain))
    .send({
      email: opts.email,
      password: opts.password ?? SEEDED_PASSWORD,
    })
    .expect(201);
  return login.body as LoginResponseBody;
}

describe('Staff (e2e)', () => {
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
    // FK-safe order (same convention as appointments.e2e-spec.ts /
    // role-matrix.e2e-spec.ts): memberships -> users -> tenants.
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
  });

  afterAll(async () => {
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
    await app.close();
    await raw.$disconnect();
  });

  it('creates, lists, logs in as the new member, updates role, enforces write permission (403), deactivates (409/204), and rejects duplicate email (409)', async () => {
    const subdomain = 'clinica-staff-a';
    const clinicA = await registerAndLogin(app, {
      clinicName: 'Clinica Staff A',
      subdomain,
      email: 'owner@clinica-staff-a.com',
    });

    // --- 1. ADMIN creates a DENTIST via POST /staff -> GET /staff includes
    // it (with email) -> the new DENTIST can log in on the clinic host.
    const dentistEmail = 'dentist@clinica-staff-a.com';
    const createDentist = await request(app.getHttpServer())
      .post('/api/v1/staff')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        fullName: 'Seeded Dentist',
        email: dentistEmail,
        role: ClinicRole.DENTIST,
        password: SEEDED_PASSWORD,
      })
      .expect(201);
    const dentist = createDentist.body as StaffMemberResponseBody;
    expect(dentist.userId).toBeDefined();
    expect(dentist.email).toBe(dentistEmail);
    expect(dentist.role).toBe(ClinicRole.DENTIST);

    const listAfterCreate = await request(app.getHttpServer())
      .get('/api/v1/staff')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const listAfterCreateBody =
      listAfterCreate.body as StaffMemberResponseBody[];
    expect(
      listAfterCreateBody.find((m) => m.userId === dentist.userId),
    ).toMatchObject({
      userId: dentist.userId,
      email: dentistEmail,
      role: ClinicRole.DENTIST,
    });

    const dentistLogin = await loginAs(app, {
      subdomain,
      email: dentistEmail,
    });
    expect(dentistLogin.accessToken).toBeDefined();
    expect(dentistLogin.refreshToken).toBeDefined();
    const dentistToken = dentistLogin.accessToken;

    // --- 2. ADMIN PATCHes the DENTIST's role to ASSISTANT -> 200, role
    // updated in GET /staff.
    const patchRole = await request(app.getHttpServer())
      .patch(`/api/v1/staff/${dentist.userId}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({ role: ClinicRole.ASSISTANT })
      .expect(200);
    expect((patchRole.body as StaffMemberResponseBody).role).toBe(
      ClinicRole.ASSISTANT,
    );

    const listAfterPatch = await request(app.getHttpServer())
      .get('/api/v1/staff')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const listAfterPatchBody = listAfterPatch.body as StaffMemberResponseBody[];
    expect(
      listAfterPatchBody.find((m) => m.userId === dentist.userId),
    ).toMatchObject({ userId: dentist.userId, role: ClinicRole.ASSISTANT });

    // --- 3. A DENTIST (no write permission on /staff) POSTs -> 403. The
    // token was issued while the actor's role was still DENTIST -- the JWT
    // carries a role snapshot from login time (RolesGuard reads it straight
    // off the JWT payload, not a fresh DB lookup), so it stays a valid
    // DENTIST-permission probe even though that same user was demoted to
    // ASSISTANT in step 2 above.
    await request(app.getHttpServer())
      .post('/api/v1/staff')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${dentistToken}`)
      .send({
        fullName: 'Intento Dentist',
        email: 'intento-dentist@clinica-staff-a.com',
        role: ClinicRole.RECEPTION,
        password: SEEDED_PASSWORD,
      })
      .expect(403);

    // --- 4a. DELETE the last ADMIN -> 409. With OWNER gone, STAFF_WRITE_ROLES
    // is ADMIN-only, so exercising "cannot deactivate the last admin" with an
    // actor different from the target (i.e. NOT tripping the "cannot
    // deactivate yourself" check, which runs first) needs a bit of setup:
    // seed a second ADMIN, log it in (JWT role claim: ADMIN), then have
    // clinicA legitimately PATCH that second admin's role down to DENTIST.
    // That leaves clinicA as the sole ACTIVE admin in the DB, while the
    // second admin's already-issued JWT still claims role ADMIN -- the
    // RolesGuard reads the role straight off the JWT, not a fresh DB lookup
    // (same snapshot behaviour exploited by the DENTIST-token probe in step 3
    // above), so that stale token still clears STAFF_WRITE_ROLES and can
    // attempt to deactivate clinicA as a genuinely different actor.
    const secondAdminEmail = 'admin2@clinica-staff-a.com';
    const secondAdmin = await seedRoledMember(
      clinicA.tenantId,
      secondAdminEmail,
      ClinicRole.ADMIN,
      'Seeded Admin',
    );
    const secondAdminLogin = await loginAs(app, {
      subdomain,
      email: secondAdminEmail,
    });

    await request(app.getHttpServer())
      .patch(`/api/v1/staff/${secondAdmin.userId}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({ role: ClinicRole.DENTIST })
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/api/v1/staff/${clinicA.userId}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${secondAdminLogin.accessToken}`)
      .expect(409);

    // Sole ADMIN is still listed (delete above must not have taken effect).
    const listAfterFailedDelete = await request(app.getHttpServer())
      .get('/api/v1/staff')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    expect(
      (listAfterFailedDelete.body as StaffMemberResponseBody[]).some(
        (m) => m.userId === clinicA.userId && m.role === ClinicRole.ADMIN,
      ),
    ).toBe(true);

    // --- 4b. DELETE a normal member (the demoted second admin, now DENTIST)
    // -> 204, and it disappears from GET /staff.
    await request(app.getHttpServer())
      .delete(`/api/v1/staff/${secondAdmin.userId}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(204);

    const listAfterDelete = await request(app.getHttpServer())
      .get('/api/v1/staff')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    expect(
      (listAfterDelete.body as StaffMemberResponseBody[]).find(
        (m) => m.userId === secondAdmin.userId,
      ),
    ).toBeUndefined();

    // --- 5. POST /staff with an already-used email -> 409.
    await request(app.getHttpServer())
      .post('/api/v1/staff')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        fullName: 'Duplicado',
        email: dentistEmail,
        role: ClinicRole.RECEPTION,
        password: SEEDED_PASSWORD,
      })
      .expect(409);
  });
});
