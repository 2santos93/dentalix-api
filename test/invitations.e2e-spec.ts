import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { CapturingMailer } from './support/capture-mailer';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import { resetDatabase } from './support/e2e-fixtures';

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para seed/cleanup — usa
// DIRECT_URL (rol owner `dentalix`, superuser) porque, con RLS aplicado, una
// conexión sin contexto de tenant (rol dentalix_app vía DATABASE_URL) ve 0
// filas y no podría sembrar/limpiar datos ajenos al tenant. Mismo patrón que
// staff.e2e-spec.ts / appointments.e2e-spec.ts.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
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
}

interface PublicInvitationResponseBody {
  status: string;
  clinicName?: string;
  role?: ClinicRole;
  maskedEmail?: string;
  requiresCurrentPassword?: boolean;
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
  const register = await registerVerified(app, {
    clinicName: opts.clinicName,
    subdomain: opts.subdomain,
    email: opts.email,
    password: SEEDED_PASSWORD,
    fullName: 'Dr. Owner',
  });
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
  // DX-029: el token solo viaja por email; los tests lo leen del transporte.
  const mailer = new CapturingMailer();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();
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
    await resetDatabase(raw);
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
      .send({
        fullName: 'Nueva Persona',
        email: newEmail,
        role: ClinicRole.DENTIST,
      })
      .expect(201);
    const created = createRes.body as CreatedInvitationResponseBody;
    // DX-029: el ADMIN ya no recibe el token; llega solo en el email.
    expect(created).not.toHaveProperty('token');
    expect(created.status).toBe('VALID');
    expect(created.role).toBe(ClinicRole.DENTIST);
    const token = await mailer.invitationToken(newEmail);

    // GET público, SIN Authorization -> 200, VALID, requiresCurrentPassword false, correo
    // enmascarado (no el correo completo).
    const publicGet = await request(app.getHttpServer())
      .get(`/api/v1/public/invitations/${token}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .expect(200);
    const publicGetBody = publicGet.body as PublicInvitationResponseBody;
    expect(publicGetBody.status).toBe('VALID');
    expect(publicGetBody.requiresCurrentPassword).toBe(false);
    expect(publicGetBody).not.toHaveProperty('userExists');
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
    expect(staffListBody.find((m) => m.email === newEmail)).toMatchObject({
      email: newEmail,
      role: ClinicRole.DENTIST,
    });

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

    await request(app.getHttpServer())
      .post('/api/v1/staff/invitations')
      .set('X-Tenant-Host', hostFor(clinicB.subdomain))
      .set('Authorization', `Bearer ${clinicB.accessToken}`)
      .send({
        fullName: 'Nueva Persona',
        email: newEmail,
        role: ClinicRole.RECEPTION,
      })
      .expect(201);
    mailer.clear();
    const tokenB = await mailer.invitationToken(newEmail);

    // GET público en B: la persona YA tiene cuenta verificada (el token le
    // llegó a su email, así que solo ella lo ve).
    const publicGetB = await request(app.getHttpServer())
      .get(`/api/v1/public/invitations/${tokenB}`)
      .set('X-Tenant-Host', hostFor(clinicB.subdomain))
      .expect(200);
    expect(
      (publicGetB.body as PublicInvitationResponseBody).requiresCurrentPassword,
    ).toBe(true);

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

  it('caso 2b: GET /staff/invitations lista las invitaciones de la clínica (no lo captura GET /staff/:userId)', async () => {
    // DX-068: StaffController (GET /staff/:userId, con ParseUUIDPipe) se
    // registraba antes que StaffInvitationsController, así que "invitations"
    // caía en :userId y la lista respondía 400. Lo destapó el unit
    // src/auth-matrix.spec.ts ("ninguna ruta queda tapada...").
    const clinic = await registerAndLogin(app, {
      clinicName: 'Clinica Inv Lista',
      subdomain: 'clinica-inv-lista',
      email: 'owner@clinica-inv-lista.com',
    });
    const created = await request(app.getHttpServer())
      .post('/api/v1/staff/invitations')
      .set('X-Tenant-Host', hostFor(clinic.subdomain))
      .set('Authorization', `Bearer ${clinic.accessToken}`)
      .send({
        fullName: 'Persona Listada',
        email: 'listada@example.com',
        role: ClinicRole.ASSISTANT,
      })
      .expect(201);

    const list = await request(app.getHttpServer())
      .get('/api/v1/staff/invitations')
      .set('X-Tenant-Host', hostFor(clinic.subdomain))
      .set('Authorization', `Bearer ${clinic.accessToken}`)
      .expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({
        id: (created.body as CreatedInvitationResponseBody).id,
        email: 'listada@example.com',
        status: 'VALID',
      }),
    ]);
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

    await request(app.getHttpServer())
      .post('/api/v1/staff/invitations')
      .set('X-Tenant-Host', hostFor(clinicD.subdomain))
      .set('Authorization', `Bearer ${clinicD.accessToken}`)
      .send({
        fullName: 'Ya Existe',
        email: existingEmail,
        role: ClinicRole.RECEPTION,
      })
      .expect(201);
    const token = await mailer.invitationToken(existingEmail);

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

  it('DX-089: un miembro restringido a sedes, dado de baja y reinvitado, conserva su restricción en el token de la aceptación', async () => {
    const clinic = await registerAndLogin(app, {
      clinicName: 'Clinica Inv Sedes',
      subdomain: 'clinica-inv-sedes',
      email: 'owner@clinica-inv-sedes.com',
    });
    const email = 'recepcion.sede@example.com';
    const { userId } = await seedRoledMember(
      clinic.tenantId,
      email,
      ClinicRole.RECEPTION,
      'Recepción Sede',
    );
    const principal = await raw.location.findFirstOrThrow({
      where: { tenantId: clinic.tenantId, deletedAt: null },
      select: { id: true },
    });
    const membership = await raw.clinicMembership.findFirstOrThrow({
      where: { tenantId: clinic.tenantId, userId },
      select: { id: true },
    });
    await raw.membershipLocation.create({
      data: {
        tenantId: clinic.tenantId,
        membershipId: membership.id,
        locationId: principal.id,
      },
    });

    // Baja (borrado lógico: sus filas de sedes sobreviven) y reinvitación.
    await request(app.getHttpServer())
      .delete(`/api/v1/staff/${userId}`)
      .set('X-Tenant-Host', hostFor(clinic.subdomain))
      .set('Authorization', `Bearer ${clinic.accessToken}`)
      .expect(204);
    await request(app.getHttpServer())
      .post('/api/v1/staff/invitations')
      .set('X-Tenant-Host', hostFor(clinic.subdomain))
      .set('Authorization', `Bearer ${clinic.accessToken}`)
      .send({ fullName: 'Recepción Sede', email, role: ClinicRole.RECEPTION })
      .expect(201);
    const token = await mailer.invitationToken(email);

    const acceptRes = await request(app.getHttpServer())
      .post(`/api/v1/public/invitations/${token}/accept`)
      .set('X-Tenant-Host', hostFor(clinic.subdomain))
      .send({ password: SEEDED_PASSWORD })
      .expect(201);
    const { accessToken } = acceptRes.body as LoginResponseBody;
    const [, body] = accessToken.split('.');
    const claims = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(claims.role).toBe(ClinicRole.RECEPTION);
    expect(claims.loc).toEqual([principal.id]);
  });

  it('DX-089: reinvitar como ADMIN a un miembro restringido borra sus sedes: el ADMIN siempre tiene todas', async () => {
    const clinic = await registerAndLogin(app, {
      clinicName: 'Clinica Inv Sedes Admin',
      subdomain: 'clinica-inv-sedes-admin',
      email: 'owner@clinica-inv-sedes-admin.com',
    });
    const email = 'recepcion.ascendida@example.com';
    const { userId } = await seedRoledMember(
      clinic.tenantId,
      email,
      ClinicRole.RECEPTION,
      'Recepción Ascendida',
    );
    const principal = await raw.location.findFirstOrThrow({
      where: { tenantId: clinic.tenantId, deletedAt: null },
      select: { id: true },
    });
    const auth = (t: request.Test) =>
      t
        .set('X-Tenant-Host', hostFor(clinic.subdomain))
        .set('Authorization', `Bearer ${clinic.accessToken}`);
    await auth(
      request(app.getHttpServer()).put(`/api/v1/staff/${userId}/locations`),
    )
      .send({ locationIds: [principal.id] })
      .expect(200);
    await auth(
      request(app.getHttpServer()).delete(`/api/v1/staff/${userId}`),
    ).expect(204);
    await auth(request(app.getHttpServer()).post('/api/v1/staff/invitations'))
      .send({ fullName: 'Recepción Ascendida', email, role: ClinicRole.ADMIN })
      .expect(201);
    const token = await mailer.invitationToken(email);

    const acceptRes = await request(app.getHttpServer())
      .post(`/api/v1/public/invitations/${token}/accept`)
      .set('X-Tenant-Host', hostFor(clinic.subdomain))
      .send({ password: SEEDED_PASSWORD })
      .expect(201);
    const { accessToken } = acceptRes.body as LoginResponseBody;
    const [, body] = accessToken.split('.');
    const claims = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(claims.role).toBe(ClinicRole.ADMIN);
    expect(claims.loc).toBeUndefined();

    expect(
      await raw.membershipLocation.count({
        where: { tenantId: clinic.tenantId, membership: { userId } },
      }),
    ).toBe(0);
    const list = await auth(
      request(app.getHttpServer()).get('/api/v1/staff'),
    ).expect(200);
    const member = (
      list.body as { userId: string; locationIds: string[] | null }[]
    ).find((m) => m.userId === userId);
    expect(member?.locationIds).toBeNull();
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
      .send({
        fullName: 'Persona Revocada',
        email: 'revocada@example.com',
        role: ClinicRole.ASSISTANT,
      })
      .expect(201);
    const created = createRes.body as CreatedInvitationResponseBody;
    const revokedToken = await mailer.invitationToken('revocada@example.com');

    await request(app.getHttpServer())
      .delete(`/api/v1/staff/invitations/${created.id}`)
      .set('X-Tenant-Host', hostFor(clinicE.subdomain))
      .set('Authorization', `Bearer ${clinicE.accessToken}`)
      .expect(204);

    const getAfterRevoke = await request(app.getHttpServer())
      .get(`/api/v1/public/invitations/${revokedToken}`)
      .set('X-Tenant-Host', hostFor(clinicE.subdomain))
      .expect(200);
    expect((getAfterRevoke.body as PublicInvitationResponseBody).status).toBe(
      'REVOKED',
    );

    await request(app.getHttpServer())
      .post(`/api/v1/public/invitations/${revokedToken}/accept`)
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
      .send({
        fullName: 'Otra Persona',
        email: 'otra@example.com',
        role: ClinicRole.RECEPTION,
      })
      .expect(403);
  });
});
