import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, DocType, PrismaClient, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para seed/cleanup — usa
// DIRECT_URL (rol owner `dentalix`, superuser) porque, con RLS aplicado, una
// conexión sin contexto de tenant (rol dentalix_app vía DATABASE_URL) ve 0
// filas y no podría sembrar/limpiar datos ajenos al tenant. Ver
// odontogram.e2e-spec.ts / clinical-history.e2e-spec.ts para el mismo patrón.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// Misma estrategia de hash que el registro (RegisterClinicUseCase ->
// PasswordService.hash), para que LoginUseCase.execute (PasswordService.verify)
// acepte la contraseña sembrada directamente en la fila `users`.
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

async function registerAndLogin(
  app: INestApplication<App>,
  opts: { clinicName: string; subdomain: string; email: string },
): Promise<{ tenantId: string; accessToken: string; subdomain: string }> {
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
      firstName: 'Rol',
      lastName: 'Matriz',
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
// invitación de staff todavía (ver Notas del plan de Fase 2C).
async function seedRoledMember(
  tenantId: string,
  email: string,
  role: ClinicRole,
): Promise<{ userId: string }> {
  const passwordHash = await passwordService.hash(SEEDED_PASSWORD);
  const user = await raw.user.create({
    data: {
      email,
      passwordHash,
      fullName: `Seeded ${role}`,
      // LoginUseCase / JwtAuthGuard no exigen email verificado hoy (solo
      // membership + password), pero lo marcamos igual para reflejar un
      // estado realista de un usuario invitado y aceptado.
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

describe('Role matrix (e2e)', () => {
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
    // FK-safe order (same as odontogram.e2e-spec.ts): tooth_records ->
    // medical_history_versions / clinical_entries -> dental_catalog_items ->
    // patients -> memberships -> users -> tenants.
    await raw.toothRecord.deleteMany();
    await raw.medicalHistoryVersion.deleteMany();
    await raw.clinicalEntry.deleteMany();
    await raw.dentalCatalogItem.deleteMany();
    await raw.patient.deleteMany();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
  });

  afterAll(async () => {
    await raw.toothRecord.deleteMany();
    await raw.medicalHistoryVersion.deleteMany();
    await raw.clinicalEntry.deleteMany();
    await raw.dentalCatalogItem.deleteMany();
    await raw.patient.deleteMany();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
    await app.close();
    await raw.$disconnect();
  });

  it('enforces the role matrix: reception blocked from clinical data, dentist blocked from catalog writes', async () => {
    const subdomain = 'clinica-roles-a';
    const clinicA = await registerAndLogin(app, {
      clinicName: 'Clinica Roles A',
      subdomain,
      email: 'owner@clinica-roles-a.com',
    });
    const patientA = await createPatient(
      app,
      clinicA.accessToken,
      clinicA.subdomain,
      '5001',
    );

    // --- Seed a RECEPTION and a DENTIST membership in the SAME clinic (raw
    // DIRECT_URL client, bypasses RLS -- there is no staff-invite endpoint
    // yet, see Notas in the Fase 2C plan).
    await seedRoledMember(
      clinicA.tenantId,
      'reception@clinica-roles-a.com',
      ClinicRole.RECEPTION,
    );
    await seedRoledMember(
      clinicA.tenantId,
      'dentist@clinica-roles-a.com',
      ClinicRole.DENTIST,
    );

    const receptionToken = await loginAs(app, {
      subdomain,
      email: 'reception@clinica-roles-a.com',
    });
    const dentistToken = await loginAs(app, {
      subdomain,
      email: 'dentist@clinica-roles-a.com',
    });

    // ================= RECEPTION =================
    // Allowed: patients (demographic) reads and writes.
    await request(app.getHttpServer())
      .get('/api/v1/patients')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${receptionToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${receptionToken}`)
      .send({
        firstName: 'Recepcion',
        lastName: 'Creado',
        docType: DocType.CC,
        docNumber: '5002',
        sex: Sex.M,
      })
      .expect(201);

    // Blocked: clinical data (medical-history, tooth-records) -- 403, not
    // 200/404, i.e. the RolesGuard denies BEFORE any handler logic runs.
    await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientA.id}/medical-history`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${receptionToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .put(`/api/v1/patients/${patientA.id}/medical-history`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${receptionToken}`)
      .send({ allergies: 'Intento recepcion', notes: 'No deberia guardar' })
      .expect(403);

    // The odontogram controller's read route for tooth records is
    // GET /odontogram (there is no literal GET /tooth-records -- see
    // OdontogramController: POST tooth-records, GET odontogram, GET
    // teeth/:fdi/history). It carries the same class-level
    // @Roles(...CLINICAL_ROLES), so it is the correct route to prove
    // reception is blocked from reading clinical/tooth data.
    await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientA.id}/odontogram`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${receptionToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientA.id}/tooth-records`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${receptionToken}`)
      .send({
        toothNumber: '11',
        surfaces: [],
        kind: 'DIAGNOSIS',
      })
      .expect(403);

    // ================= DENTIST =================
    // Allowed: clinical write (tooth-records) and catalog read.
    const dentistToothRecord = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientA.id}/tooth-records`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${dentistToken}`)
      .send({
        toothNumber: '21',
        surfaces: [],
        kind: 'DIAGNOSIS',
        notes: 'Registrado por dentista',
      })
      .expect(201);
    expect(
      (dentistToothRecord.body as { toothNumber: string }).toothNumber,
    ).toBe('21');

    await request(app.getHttpServer())
      .get('/api/v1/catalog/items')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${dentistToken}`)
      .expect(200);

    // Blocked: catalog write (OWNER/ADMIN only) -- 403.
    await request(app.getHttpServer())
      .post('/api/v1/catalog/items')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${dentistToken}`)
      .send({
        code: 'DENTIST-ATTEMPT',
        kind: 'DIAGNOSIS',
        labelEs: 'Intento dentista',
        color: '#112233',
      })
      .expect(403);

    // ================= OWNER (sanity: matrix permits, not deny-all) =======
    await request(app.getHttpServer())
      .post('/api/v1/catalog/items')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        code: 'OWNER-ITEM',
        kind: 'DIAGNOSIS',
        labelEs: 'Item owner',
        color: '#445566',
      })
      .expect(201);

    await request(app.getHttpServer())
      .put(`/api/v1/patients/${patientA.id}/medical-history`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({ allergies: 'Ninguna', notes: 'Guardado por owner' })
      .expect(200);
  });
});
