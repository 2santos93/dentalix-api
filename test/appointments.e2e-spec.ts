import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, DocType, PrismaClient, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';

// Las horas de este spec son un `HH:MM` fijo sobre un día SIEMPRE FUTURO:
// CreateAppointmentUseCase rechaza un `start` en el pasado, así que una fecha
// hardcodeada haría fallar la suite al pasar ese día. Anclar el día preserva las
// relaciones de solape entre los literales (10:00 / 10:15 / 10:30 ...).
// Mismo criterio que dashboard.e2e-spec.ts, que ya usaba `Date.now() + N días`.
const DAY_MS = 24 * 60 * 60 * 1000;
function isoDayIn(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}

const ANCHOR_DAY = isoDayIn(2);
function at(time: string): string {
  return `${ANCHOR_DAY}T${time}:00.000Z`;
}

/**
 * 00:00Z of the day AFTER the anchor day — the exclusive `to` bound that
 * covers the whole anchor day. This used to be hardcoded (`2026-08-02`), which
 * silently emptied every "covering" range the moment the rolling anchor day
 * caught up to that date: the list assertions then received `[]`.
 */
const AFTER_ANCHOR = `${isoDayIn(3)}T00:00:00.000Z`;

/** A range far from the anchor day, for the "does NOT cover" assertion — derived, not hardcoded, for the same reason. */
const FAR_FROM = `${isoDayIn(40)}T00:00:00.000Z`;
const FAR_TO = `${isoDayIn(41)}T00:00:00.000Z`;

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para seed/cleanup — usa
// DIRECT_URL (rol owner `dentalix`, superuser) porque, con RLS aplicado, una
// conexión sin contexto de tenant (rol dentalix_app vía DATABASE_URL) ve 0
// filas y no podría sembrar/limpiar datos ajenos al tenant. Ver
// role-matrix.e2e-spec.ts / odontogram.e2e-spec.ts para el mismo patrón.
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

interface PatientResponseBody {
  id: string;
  tenantId: string;
}

interface AppointmentResponseBody {
  id: string;
  tenantId: string;
  patientId: string;
  patientFirstName: string | null;
  patientLastName: string | null;
  providerId: string;
  start: string;
  end: string;
  status: string;
  reason: string | null;
  notes: string | null;
  createdById: string | null;
}

interface StaffMemberResponseBody {
  userId: string;
  fullName: string;
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

async function createPatient(
  app: INestApplication<App>,
  accessToken: string,
  subdomain: string,
  docNumber: string,
): Promise<PatientResponseBody> {
  const create = await request(app.getHttpServer())
    .post('/api/v1/patients')
    .set('X-Tenant-Host', hostFor(subdomain))
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      firstName: 'Agenda',
      lastName: 'Paciente',
      docType: DocType.CC,
      docNumber,
      sex: Sex.F,
    })
    .expect(201);
  return create.body as PatientResponseBody;
}

// Siembra un usuario con contraseña hasheada igual que el registro, más su
// membresía en la clínica (tenant) dada, con el rol pedido. Usa el cliente
// `raw` (DIRECT_URL, superuser) porque bypassa RLS -- no hay endpoint de
// invitación de staff todavía (mismo patrón que role-matrix.e2e-spec.ts).
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
  opts: { subdomain: string; email: string },
): Promise<string> {
  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Tenant-Host', hostFor(opts.subdomain))
    .send({
      email: opts.email,
      password: SEEDED_PASSWORD,
    })
    .expect(201);
  return (login.body as LoginResponseBody).accessToken;
}

describe('Appointments (e2e)', () => {
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
    // FK-safe order: appointments -> patients (FK) -> memberships -> users ->
    // tenants (same convention as odontogram.e2e-spec.ts / role-matrix.e2e-spec.ts).
    // tooth_records referencia patients: marcar un ítem de plan como DONE crea
    // un ToothRecord, así que se borra ANTES o el delete de patients falla por
    // FK y revienta el afterAll (contaminando las suites siguientes).
    await raw.toothRecord.deleteMany();
    await raw.appointment.deleteMany();
    await raw.patient.deleteMany();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
  });

  afterAll(async () => {
    // tooth_records referencia patients: marcar un ítem de plan como DONE crea
    // un ToothRecord, así que se borra ANTES o el delete de patients falla por
    // FK y revienta el afterAll (contaminando las suites siguientes).
    await raw.toothRecord.deleteMany();
    await raw.appointment.deleteMany();
    await raw.patient.deleteMany();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
    await app.close();
    await raw.$disconnect();
  });

  it('creates, lists by range, rejects overlap (409), allows adjacent, excludes cancelled, updates status, isolates tenants, allows reception, and lists staff', async () => {
    const subdomainA = 'clinica-agenda-a';
    const clinicA = await registerAndLogin(app, {
      clinicName: 'Clinica Agenda A',
      subdomain: subdomainA,
      email: 'owner@clinica-agenda-a.com',
    });
    const patientA = await createPatient(
      app,
      clinicA.accessToken,
      clinicA.subdomain,
      '7001',
    );

    // --- 1. Owner creates a valid appointment (provider = owner's userId).
    const create1 = await request(app.getHttpServer())
      .post('/api/v1/appointments')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        patientId: patientA.id,
        providerId: clinicA.userId,
        start: at('10:00'),
        end: at('10:30'),
        reason: 'Control de rutina',
      })
      .expect(201);
    const appt1 = create1.body as AppointmentResponseBody;
    expect(appt1.id).toBeDefined();
    expect(appt1.status).toBe('SCHEDULED');
    expect(appt1.providerId).toBe(clinicA.userId);
    // createdById is sourced from the JWT, never from the client body — it
    // must equal the authenticated actor even though it was never sent.
    expect(appt1.createdById).toBe(clinicA.userId);

    // --- 2. GET by range: a range covering it returns it; one that doesn't
    // covered range returns empty.
    const listCovering = await request(app.getHttpServer())
      .get('/api/v1/appointments')
      .query({
        from: at('00:00'),
        to: AFTER_ANCHOR,
      })
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const listCoveringBody = listCovering.body as AppointmentResponseBody[];
    expect(listCoveringBody.map((a) => a.id)).toContain(appt1.id);

    // The listed appointment carries the patient's name (joined from Patient),
    // so a client can label it without fetching the patient list — which used
    // to mean `GET /patients?pageSize=100` and a raw UUID for everyone past
    // the first 100 patients.
    const listedAppt1 = listCoveringBody.find((a) => a.id === appt1.id);
    expect(listedAppt1?.patientFirstName).toBe('Agenda');
    expect(listedAppt1?.patientLastName).toBe('Paciente');

    const listNotCovering = await request(app.getHttpServer())
      .get('/api/v1/appointments')
      .query({
        from: FAR_FROM,
        to: FAR_TO,
      })
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const listNotCoveringBody =
      listNotCovering.body as AppointmentResponseBody[];
    expect(listNotCoveringBody).toEqual([]);

    // --- 3. Overlapping appointment for the SAME provider -> 409.
    await request(app.getHttpServer())
      .post('/api/v1/appointments')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        patientId: patientA.id,
        providerId: clinicA.userId,
        start: at('10:15'),
        end: at('10:45'),
      })
      .expect(409);

    // --- 4. Adjacent appointment (start == previous end) same provider ->
    // 201, no false conflict (half-open interval).
    const create2 = await request(app.getHttpServer())
      .post('/api/v1/appointments')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        patientId: patientA.id,
        providerId: clinicA.userId,
        start: at('10:30'),
        end: at('11:00'),
      })
      .expect(201);
    const appt2 = create2.body as AppointmentResponseBody;

    // --- 5. A CANCELLED appointment does not block: cancel appt1, then
    // create in its exact slot.
    await request(app.getHttpServer())
      .patch(`/api/v1/appointments/${appt1.id}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({ status: 'CANCELLED' })
      .expect(200);

    const create3 = await request(app.getHttpServer())
      .post('/api/v1/appointments')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        patientId: patientA.id,
        providerId: clinicA.userId,
        start: at('10:00'),
        end: at('10:30'),
      })
      .expect(201);
    const appt3 = create3.body as AppointmentResponseBody;
    expect(appt3.status).toBe('SCHEDULED');

    // --- 6. PATCH status -> CONFIRMED reflected on subsequent GET.
    await request(app.getHttpServer())
      .patch(`/api/v1/appointments/${appt2.id}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({ status: 'CONFIRMED' })
      .expect(200);

    const getAppt2 = await request(app.getHttpServer())
      .get(`/api/v1/appointments/${appt2.id}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    expect((getAppt2.body as AppointmentResponseBody).status).toBe('CONFIRMED');

    // --- 7. Tenant isolation: clinic B does not see any of clinic A's
    // appointments for the same range.
    const subdomainB = 'clinica-agenda-b';
    const clinicB = await registerAndLogin(app, {
      clinicName: 'Clinica Agenda B',
      subdomain: subdomainB,
      email: 'owner@clinica-agenda-b.com',
    });

    const listAsB = await request(app.getHttpServer())
      .get('/api/v1/appointments')
      .query({
        from: at('00:00'),
        to: AFTER_ANCHOR,
      })
      .set('X-Tenant-Host', hostFor(clinicB.subdomain))
      .set('Authorization', `Bearer ${clinicB.accessToken}`)
      .expect(200);
    expect(listAsB.body as AppointmentResponseBody[]).toEqual([]);

    // --- 8. RECEPTION allowed: seed a RECEPTION membership in clinic A,
    // login, and confirm it can POST + GET /appointments (agenda is
    // reception's job — unlike clinical data, see APPOINTMENT_ROLES).
    await seedRoledMember(
      clinicA.tenantId,
      'reception@clinica-agenda-a.com',
      ClinicRole.RECEPTION,
      'Seeded RECEPTION',
    );
    const receptionToken = await loginAs(app, {
      subdomain: subdomainA,
      email: 'reception@clinica-agenda-a.com',
    });

    await request(app.getHttpServer())
      .post('/api/v1/appointments')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${receptionToken}`)
      .send({
        patientId: patientA.id,
        providerId: clinicA.userId,
        start: at('14:00'),
        end: at('14:30'),
      })
      .expect(201);

    await request(app.getHttpServer())
      .get('/api/v1/appointments')
      .query({
        from: at('00:00'),
        to: AFTER_ANCHOR,
      })
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${receptionToken}`)
      .expect(200);

    // --- 9. GET /staff (owner) returns at least the owner + seeded members.
    await seedRoledMember(
      clinicA.tenantId,
      'dentist@clinica-agenda-a.com',
      ClinicRole.DENTIST,
      'Seeded DENTIST',
    );

    const staff = await request(app.getHttpServer())
      .get('/api/v1/staff')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const staffBody = staff.body as StaffMemberResponseBody[];
    expect(staffBody.find((m) => m.userId === clinicA.userId)).toMatchObject({
      userId: clinicA.userId,
      role: ClinicRole.ADMIN,
    });
    expect(staffBody.some((m) => m.role === ClinicRole.RECEPTION)).toBe(true);
    expect(staffBody.some((m) => m.role === ClinicRole.DENTIST)).toBe(true);
    for (const member of staffBody) {
      expect(member).toHaveProperty('userId');
      expect(member).toHaveProperty('fullName');
      expect(member).toHaveProperty('role');
    }
  });
});
