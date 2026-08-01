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
// staff.e2e-spec.ts / appointments.e2e-spec.ts.
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

interface CreatedInvitationResponseBody {
  id: string;
  fullName: string;
  email: string;
  role: ClinicRole;
  expiresAt: string;
  status: string;
  token: string;
}

interface PublicInvitationResponseBody {
  status: string;
  clinicName?: string;
  role?: ClinicRole;
  maskedEmail?: string;
  userExists?: boolean;
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
// `raw` (DIRECT_URL, superuser) porque bypassa RLS — se usa aquí solo para
// sembrar un actor DENTIST y probar el guard de rol insuficiente (caso 6).
// Mismo patrón de seed que staff.e2e-spec.ts.
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

describe('Staff invitations (e2e)', () => {
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
    // FK-safe order: invitations -> memberships -> users -> tenants.
    await raw.clinicInvitation.deleteMany();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
  });

  afterAll(async () => {
    await raw.clinicInvitation.deleteMany();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
    await app.close();
    await raw.$disconnect();
  });

  it('caso 1: ciclo completo con usuario nuevo — invitar, consultar público, aceptar, aparecer en /staff, iniciar sesión', async () => {
    const subdomain = 'clinica-inv-a';
    const clinicA = await registerAndLogin(app, {
      clinicName: 'Clinica Inv A',
      subdomain,
      email: 'owner@clinica-inv-a.com',
    });

    const newEmail = 'nueva.persona@example.com';
    const createRes = await request(app.getHttpServer())
      .post('/api/v1/staff/invitations')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({ fullName: 'Nueva Persona', email: newEmail, role: ClinicRole.DENTIST })
      .expect(201);
    const created = createRes.body as CreatedInvitationResponseBody;
    expect(created.token).toEqual(expect.any(String));
    expect(created.status).toBe('VALID');
    expect(created.role).toBe(ClinicRole.DENTIST);
    const token = created.token;

    // GET público, SIN Authorization -> 200, VALID, userExists false, correo
    // enmascarado (no el correo completo).
    const publicGet = await request(app.getHttpServer())
      .get(`/api/v1/public/invitations/${token}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .expect(200);
    const publicGetBody = publicGet.body as PublicInvitationResponseBody;
    expect(publicGetBody.status).toBe('VALID');
    expect(publicGetBody.userExists).toBe(false);
    expect(publicGetBody.role).toBe(ClinicRole.DENTIST);
    expect(publicGetBody.maskedEmail).toBeDefined();
    expect(publicGetBody.maskedEmail).not.toBe(newEmail);

    // Aceptar con contraseña nueva -> 201 con tokens.
    const newPassword = 'NuevaPass123!';
    const acceptRes = await request(app.getHttpServer())
      .post(`/api/v1/public/invitations/${token}/accept`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .send({ password: newPassword })
      .expect(201);
    const acceptBody = acceptRes.body as LoginResponseBody;
    expect(acceptBody.accessToken).toEqual(expect.any(String));
    expect(acceptBody.refreshToken).toEqual(expect.any(String));

    // Aparece en GET /staff con el rol invitado.
    const staffList = await request(app.getHttpServer())
      .get('/api/v1/staff')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const staffListBody = staffList.body as StaffMemberResponseBody[];
    expect(
      staffListBody.find((m) => m.email === newEmail),
    ).toMatchObject({ email: newEmail, role: ClinicRole.DENTIST });

    // Puede autenticarse con el correo/contraseña recién definidos.
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .send({ email: newEmail, password: newPassword })
      .expect(201);
    expect((loginRes.body as LoginResponseBody).accessToken).toEqual(
      expect.any(String),
    );

    // --- caso 4: un solo uso — repetir el accept del caso 1 -> 410, y GET
    // devuelve USED.
    await request(app.getHttpServer())
      .post(`/api/v1/public/invitations/${token}/accept`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .send({ password: newPassword })
      .expect(410);

    const usedGet = await request(app.getHttpServer())
      .get(`/api/v1/public/invitations/${token}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .expect(200);
    expect((usedGet.body as PublicInvitationResponseBody).status).toBe('USED');

    // --- caso 2: multi-clínica — la misma persona, ya existente, es
    // invitada con otro rol en una SEGUNDA clínica; acepta con su
    // contraseña EXISTENTE; queda con ese rol en B y conserva su rol
    // original en A.
    const subdomainB = 'clinica-inv-b';
    const clinicB = await registerAndLogin(app, {
      clinicName: 'Clinica Inv B',
      subdomain: subdomainB,
      email: 'owner@clinica-inv-b.com',
    });

    const createResB = await request(app.getHttpServer())
      .post('/api/v1/staff/invitations')
      .set('X-Tenant-Host', hostFor(clinicB.subdomain))
      .set('Authorization', `Bearer ${clinicB.accessToken}`)
      .send({ fullName: 'Nueva Persona', email: newEmail, role: ClinicRole.RECEPTION })
      .expect(201);
    const tokenB = (createResB.body as CreatedInvitationResponseBody).token;

    // GET público en B: la persona YA existe globalmente.
    const publicGetB = await request(app.getHttpServer())
      .get(`/api/v1/public/invitations/${tokenB}`)
      .set('X-Tenant-Host', hostFor(clinicB.subdomain))
      .expect(200);
    expect((publicGetB.body as PublicInvitationResponseBody).userExists).toBe(
      true,
    );

    await request(app.getHttpServer())
      .post(`/api/v1/public/invitations/${tokenB}/accept`)
      .set('X-Tenant-Host', hostFor(clinicB.subdomain))
      .send({ password: newPassword })
      .expect(201);

    const staffListB = await request(app.getHttpServer())
      .get('/api/v1/staff')
      .set('X-Tenant-Host', hostFor(clinicB.subdomain))
      .set('Authorization', `Bearer ${clinicB.accessToken}`)
      .expect(200);
    expect(
      (staffListB.body as StaffMemberResponseBody[]).find(
        (m) => m.email === newEmail,
      ),
    ).toMatchObject({ email: newEmail, role: ClinicRole.RECEPTION });

    // Sigue con su rol original (DENTIST) en la clínica A.
    const staffListAAfter = await request(app.getHttpServer())
      .get('/api/v1/staff')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    expect(
      (staffListAAfter.body as StaffMemberResponseBody[]).find(
        (m) => m.email === newEmail,
      ),
    ).toMatchObject({ email: newEmail, role: ClinicRole.DENTIST });
  });

  it('caso 3: contraseña incorrecta de un usuario existente -> 401, y la invitación sigue VALID', async () => {
    const subdomain = 'clinica-inv-c';
    const clinicC = await registerAndLogin(app, {
      clinicName: 'Clinica Inv C',
      subdomain,
      email: 'owner@clinica-inv-c.com',
    });

    // La persona invitada ya existe como USUARIO global (con contraseña
    // conocida, SEEDED_PASSWORD) por su membresía sembrada en clinicC; lo
    // que importa para este caso es esa existencia global por correo -- la
    // invitación real se emite desde una clínica DISTINTA (D) más abajo.
    const existingEmail = 'ya.existe@example.com';
    await seedRoledMember(
      clinicC.tenantId,
      existingEmail,
      ClinicRole.ASSISTANT,
      'Ya Existe',
    );
    const subdomainD = 'clinica-inv-d';
    const clinicD = await registerAndLogin(app, {
      clinicName: 'Clinica Inv D',
      subdomain: subdomainD,
      email: 'owner@clinica-inv-d.com',
    });

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/staff/invitations')
      .set('X-Tenant-Host', hostFor(clinicD.subdomain))
      .set('Authorization', `Bearer ${clinicD.accessToken}`)
      .send({ fullName: 'Ya Existe', email: existingEmail, role: ClinicRole.RECEPTION })
      .expect(201);
    const token = (createRes.body as CreatedInvitationResponseBody).token;

    await request(app.getHttpServer())
      .post(`/api/v1/public/invitations/${token}/accept`)
      .set('X-Tenant-Host', hostFor(clinicD.subdomain))
      .send({ password: 'ContraseñaIncorrecta1!' })
      .expect(401);

    const getAfter = await request(app.getHttpServer())
      .get(`/api/v1/public/invitations/${token}`)
      .set('X-Tenant-Host', hostFor(clinicD.subdomain))
      .expect(200);
    expect((getAfter.body as PublicInvitationResponseBody).status).toBe(
      'VALID',
    );
  });

  it('caso 5: revocada — invitar, DELETE (204), luego GET -> REVOKED y accept -> 410', async () => {
    const subdomain = 'clinica-inv-e';
    const clinicE = await registerAndLogin(app, {
      clinicName: 'Clinica Inv E',
      subdomain,
      email: 'owner@clinica-inv-e.com',
    });

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/staff/invitations')
      .set('X-Tenant-Host', hostFor(clinicE.subdomain))
      .set('Authorization', `Bearer ${clinicE.accessToken}`)
      .send({ fullName: 'Persona Revocada', email: 'revocada@example.com', role: ClinicRole.ASSISTANT })
      .expect(201);
    const created = createRes.body as CreatedInvitationResponseBody;

    await request(app.getHttpServer())
      .delete(`/api/v1/staff/invitations/${created.id}`)
      .set('X-Tenant-Host', hostFor(clinicE.subdomain))
      .set('Authorization', `Bearer ${clinicE.accessToken}`)
      .expect(204);

    const getAfterRevoke = await request(app.getHttpServer())
      .get(`/api/v1/public/invitations/${created.token}`)
      .set('X-Tenant-Host', hostFor(clinicE.subdomain))
      .expect(200);
    expect((getAfterRevoke.body as PublicInvitationResponseBody).status).toBe(
      'REVOKED',
    );

    await request(app.getHttpServer())
      .post(`/api/v1/public/invitations/${created.token}/accept`)
      .set('X-Tenant-Host', hostFor(clinicE.subdomain))
      .send({ password: 'CualquierPass123!' })
      .expect(410);
  });

  it('caso 6: rol insuficiente — un DENTIST sembrado no puede POST /staff/invitations -> 403', async () => {
    const subdomain = 'clinica-inv-f';
    const clinicF = await registerAndLogin(app, {
      clinicName: 'Clinica Inv F',
      subdomain,
      email: 'owner@clinica-inv-f.com',
    });

    const dentistEmail = 'dentist@clinica-inv-f.com';
    await seedRoledMember(
      clinicF.tenantId,
      dentistEmail,
      ClinicRole.DENTIST,
      'Seeded Dentist',
    );
    const dentistLogin = await loginAs(app, {
      subdomain: clinicF.subdomain,
      email: dentistEmail,
    });

    await request(app.getHttpServer())
      .post('/api/v1/staff/invitations')
      .set('X-Tenant-Host', hostFor(clinicF.subdomain))
      .set('Authorization', `Bearer ${dentistLogin.accessToken}`)
      .send({ fullName: 'Otra Persona', email: 'otra@example.com', role: ClinicRole.RECEPTION })
      .expect(403);
  });
});
