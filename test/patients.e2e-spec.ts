import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Prisma, PrismaClient, DocType, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { resetDatabase } from './support/e2e-fixtures';

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para el cleanup en
// beforeAll/afterAll — usa DIRECT_URL (rol owner `dentalix`, superuser)
// porque, con RLS aplicado, una conexión sin contexto de tenant (rol
// dentalix_app vía DATABASE_URL) ve 0 filas y no podría limpiar datos de
// corridas anteriores. Ver auth.e2e-spec.ts para el mismo patrón.
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

interface PatientResponseBody {
  id: string;
  tenantId: string;
  firstName: string;
  lastName: string;
  email: string | null;
}

interface ListPatientsResponseBody {
  items: PatientResponseBody[];
  total: number;
  page: number;
  pageSize: number;
}

interface MedicalHistoryResponseBody {
  version: number;
  allergies: unknown[];
  safetyFlags: { alergiaPenicilina: boolean; embarazo: boolean };
  hasCriticalAlert: boolean;
}

async function registerAndLogin(
  app: INestApplication<App>,
  opts: { clinicName: string; subdomain: string; email: string },
): Promise<{ tenantId: string; accessToken: string; subdomain: string }> {
  const register = await registerVerified(app, {
    clinicName: opts.clinicName,
    subdomain: opts.subdomain,
    email: opts.email,
    password: 'S3cret!!',
    fullName: 'Dr. Owner',
  });
  const registerBody = register.body as RegisterResponseBody;

  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Tenant-Host', hostFor(opts.subdomain))
    .send({
      email: opts.email,
      password: 'S3cret!!',
    })
    .expect(201);
  const loginBody = login.body as LoginResponseBody;

  return {
    tenantId: registerBody.tenantId,
    accessToken: loginBody.accessToken,
    subdomain: opts.subdomain,
  };
}

describe('Patients (e2e)', () => {
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
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('creates, lists and gets a patient for the authenticated tenant', async () => {
    const clinicA = await registerAndLogin(app, {
      clinicName: 'Clinica A',
      subdomain: 'clinica-a',
      email: 'owner@clinica-a.com',
    });

    const create = await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        firstName: 'Ana',
        lastName: 'Gomez',
        docType: DocType.CC,
        docNumber: '1001',
        sex: Sex.F,
        // No surrounding whitespace: class-validator's IsEmail() rejects a
        // padded string as an invalid address (that's not what trim/lowercase
        // normalization is about) — mixed case alone still exercises it.
        email: 'Ana.Gomez@Example.COM',
      })
      .expect(201);
    const created = create.body as PatientResponseBody;
    expect(created.id).toBeDefined();
    expect(created.tenantId).toBe(clinicA.tenantId);
    expect(created.firstName).toBe('Ana');
    // createdById is pulled from the JWT (req.user.sub), never from the body.
    expect(created.email).toBe('ana.gomez@example.com');

    const list = await request(app.getHttpServer())
      .get('/api/v1/patients')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const listBody = list.body as ListPatientsResponseBody;
    expect(listBody.items.some((p) => p.id === created.id)).toBe(true);
    expect(listBody.total).toBeGreaterThanOrEqual(1);

    const get = await request(app.getHttpServer())
      .get(`/api/v1/patients/${created.id}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const getBody = get.body as PatientResponseBody;
    expect(getBody.id).toBe(created.id);

    const update = await request(app.getHttpServer())
      .patch(`/api/v1/patients/${created.id}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({ phone: '3001234567' })
      .expect(200);
    const updateBody = update.body as PatientResponseBody & {
      phone: string | null;
    };
    expect(updateBody.phone).toBe('3001234567');

    // Los campos administrativos se pueden CREAR (CreatePatientDto) pero hasta
    // ahora no editar: UpdatePatientDto no los aceptaba y ValidationPipe con
    // whitelist:true los descartaba en silencio.
    const patchAdmin = await request(app.getHttpServer())
      .patch(`/api/v1/patients/${created.id}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        occupation: 'Docente',
        // DX-153: DEPRECADO y de solo lectura: se descarta sin error.
        insurerEps: 'Sura',
        maritalStatus: 'Casado',
        physicianName: 'Dra. Ruiz',
        physicianPhone: '+57 300 000 0000',
        emergencyContactName: 'Ana Pérez',
        emergencyContactRelationship: 'Madre',
        emergencyContactPhone: '+57 300 111 1111',
        // DX-203: DEPRECADO y de solo lectura: se descartan sin error.
        guardianName: 'Luis Pérez',
        guardianDocNumber: '9001',
      })
      .expect(200);
    const admin = patchAdmin.body as Record<string, unknown>;
    expect(admin.occupation).toBe('Docente');
    expect(admin.insurerEps).toBeNull();
    expect(admin.emergencyContactName).toBe('Ana Pérez');
    expect(admin.guardianName).toBeNull();
    expect(admin.guardianDocNumber).toBeNull();

    // `null` VACÍA un campo que la columna admite como nulo. Es la única forma
    // de corregir un dato mal cargado: omitirlo lo deja como estaba.
    const patchClear = await request(app.getHttpServer())
      .patch(`/api/v1/patients/${created.id}`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({ occupation: null, phone: null, birthDate: null })
      .expect(200);
    const cleared = patchClear.body as Record<string, unknown>;
    expect(cleared.occupation).toBeNull();
    expect(cleared.phone).toBeNull();
    // birthDate era el caso peligroso: `new Date(null)` da 1970-01-01, así que
    // un null mal manejado escribía una fecha falsa en vez de vaciar.
    expect(cleared.birthDate).toBeNull();
    // Lo omitido no se toca (y `insurerEps` sigue como estaba: nunca se escribe).
    expect(cleared.insurerEps).toBeNull();
  });

  it('rejects null on columns that are NOT NULL, with 400 instead of a 500', async () => {
    // `@IsOptional()` de class-validator saltea TODOS los validadores cuando el
    // valor es null, así que un `firstName: null` pasaba la validación, llegaba
    // a Prisma y reventaba la restricción NOT NULL como un 500 genérico.
    const clinic = await registerAndLogin(app, {
      clinicName: 'Clinica Not Null',
      subdomain: 'clinica-notnull',
      email: 'owner@clinica-notnull.com',
    });
    const create = await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set('X-Tenant-Host', hostFor(clinic.subdomain))
      .set('Authorization', `Bearer ${clinic.accessToken}`)
      .send({
        firstName: 'Nulo',
        lastName: 'Prueba',
        docType: DocType.CC,
        docNumber: '8100',
        sex: Sex.M,
      })
      .expect(201);
    const patient = create.body as PatientResponseBody;

    for (const field of ['firstName', 'lastName', 'docType', 'sex']) {
      await request(app.getHttpServer())
        .patch(`/api/v1/patients/${patient.id}`)
        .set('X-Tenant-Host', hostFor(clinic.subdomain))
        .set('Authorization', `Bearer ${clinic.accessToken}`)
        .send({ [field]: null })
        .expect(400);
    }

    // El paciente sigue intacto tras los rechazos.
    const after = await request(app.getHttpServer())
      .get(`/api/v1/patients/${patient.id}`)
      .set('X-Tenant-Host', hostFor(clinic.subdomain))
      .set('Authorization', `Bearer ${clinic.accessToken}`)
      .expect(200);
    expect((after.body as { firstName: string }).firstName).toBeTruthy();
  });

  // DX-043 (DB-004/DB-005): búsqueda sin tildes ni mayúsculas, por documento,
  // aislada por tenant, y `page` con tope (400 en español por encima).
  it('searches ignoring accents and case, by document, only in the own tenant, and caps page', async () => {
    const clinicA = await registerAndLogin(app, {
      clinicName: 'Clinica Busqueda A',
      subdomain: 'clinica-busca-a',
      email: 'owner@clinica-busca-a.com',
    });
    const clinicB = await registerAndLogin(app, {
      clinicName: 'Clinica Busqueda B',
      subdomain: 'clinica-busca-b',
      email: 'owner@clinica-busca-b.com',
    });
    const createIn = async (
      clinic: { subdomain: string; accessToken: string },
      body: Record<string, string>,
    ) =>
      (
        await request(app.getHttpServer())
          .post('/api/v1/patients')
          .set('X-Tenant-Host', hostFor(clinic.subdomain))
          .set('Authorization', `Bearer ${clinic.accessToken}`)
          .send({ docType: DocType.CC, sex: Sex.M, ...body })
          .expect(201)
      ).body as PatientResponseBody;
    const jose = await createIn(clinicA, {
      firstName: 'José',
      lastName: 'Pérez',
      docNumber: '71234567',
    });
    await createIn(clinicB, {
      firstName: 'Jose',
      lastName: 'Ajeno',
      docNumber: '71234567',
    });
    const search = async (query: string) =>
      (
        await request(app.getHttpServer())
          .get('/api/v1/patients')
          .query({ query })
          .set('X-Tenant-Host', hostFor(clinicA.subdomain))
          .set('Authorization', `Bearer ${clinicA.accessToken}`)
          .expect(200)
      ).body as ListPatientsResponseBody;

    for (const q of ['jose', 'JOSE PEREZ', 'pérez', '1234']) {
      const body = await search(q);
      expect(body.items.map((p) => p.id)).toEqual([jose.id]);
      expect(body.total).toBe(1);
    }

    const tooFar = await request(app.getHttpServer())
      .get('/api/v1/patients')
      .query({ page: 5001 })
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(400);
    expect(JSON.stringify(tooFar.body)).toContain('page admite hasta 5000.');

    await request(app.getHttpServer())
      .get('/api/v1/patients')
      .query({ page: 5000 })
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
  });

  it('rejects requests without a bearer token', async () => {
    await request(app.getHttpServer()).get('/api/v1/patients').expect(401);
  });

  it('isolates patients between tenants (RLS end-to-end)', async () => {
    const clinicA = await registerAndLogin(app, {
      clinicName: 'Clinica Isolation A',
      subdomain: 'clinica-iso-a',
      email: 'owner@clinica-iso-a.com',
    });
    const clinicB = await registerAndLogin(app, {
      clinicName: 'Clinica Isolation B',
      subdomain: 'clinica-iso-b',
      email: 'owner@clinica-iso-b.com',
    });

    const createA = await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        firstName: 'Solo',
        lastName: 'DeA',
        docType: DocType.CC,
        docNumber: '2002',
        sex: Sex.M,
      })
      .expect(201);
    const patientA = createA.body as PatientResponseBody;

    // Clinic B's list must NOT include clinic A's patient.
    const listAsB = await request(app.getHttpServer())
      .get('/api/v1/patients')
      .set('X-Tenant-Host', hostFor(clinicB.subdomain))
      .set('Authorization', `Bearer ${clinicB.accessToken}`)
      .expect(200);
    const listAsBBody = listAsB.body as ListPatientsResponseBody;
    expect(listAsBBody.items.some((p) => p.id === patientA.id)).toBe(false);

    // Clinic B fetching clinic A's patient by id must 404 (RLS makes the row
    // invisible; a missing row and a cross-tenant row are indistinguishable
    // by design — see GetPatientUseCase).
    await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientA.id}`)
      .set('X-Tenant-Host', hostFor(clinicB.subdomain))
      .set('Authorization', `Bearer ${clinicB.accessToken}`)
      .expect(404);

    // Sanity: clinic A still sees its own patient.
    const listAsA = await request(app.getHttpServer())
      .get('/api/v1/patients')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const listAsABody = listAsA.body as ListPatientsResponseBody;
    expect(listAsABody.items.some((p) => p.id === patientA.id)).toBe(true);
  });

  it('creates a patient with a medicalHistory payload and persists it as v1 with derived safety flags', async () => {
    const clinic = await registerAndLogin(app, {
      clinicName: 'Clinica Historia Alta',
      subdomain: 'clinica-historia-alta',
      email: 'owner@clinica-historia-alta.com',
    });

    const create = await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set('X-Tenant-Host', hostFor(clinic.subdomain))
      .set('Authorization', `Bearer ${clinic.accessToken}`)
      .send({
        firstName: 'Con',
        lastName: 'Historia',
        docType: DocType.CC,
        docNumber: '4001',
        sex: Sex.F,
        medicalHistory: {
          allergies: [
            {
              alergeno: 'Penicilina',
              tipo: 'MEDICAMENTO',
              severidad: 'ANAFILAXIA',
              esAlerta: true,
            },
          ],
          embarazo: true,
        },
      })
      .expect(201);
    const created = create.body as PatientResponseBody;

    const getHistory = await request(app.getHttpServer())
      .get(`/api/v1/patients/${created.id}/medical-history`)
      .set('X-Tenant-Host', hostFor(clinic.subdomain))
      .set('Authorization', `Bearer ${clinic.accessToken}`)
      .expect(200);
    const historyBody = getHistory.body as MedicalHistoryResponseBody;
    expect(historyBody.version).toBe(1);
    expect(historyBody.allergies).toHaveLength(1);
    expect(historyBody.safetyFlags.alergiaPenicilina).toBe(true);
    expect(historyBody.safetyFlags.embarazo).toBe(true);
    expect(historyBody.hasCriticalAlert).toBe(true);
  });

  it('creates a patient without a medicalHistory payload and leaves medical-history absent', async () => {
    const clinic = await registerAndLogin(app, {
      clinicName: 'Clinica Sin Historia',
      subdomain: 'clinica-sin-historia',
      email: 'owner@clinica-sin-historia.com',
    });

    const create = await request(app.getHttpServer())
      .post('/api/v1/patients')
      .set('X-Tenant-Host', hostFor(clinic.subdomain))
      .set('Authorization', `Bearer ${clinic.accessToken}`)
      .send({
        firstName: 'Sin',
        lastName: 'Historia',
        docType: DocType.CC,
        docNumber: '4002',
        sex: Sex.M,
      })
      .expect(201);
    const created = create.body as PatientResponseBody;

    // 200 + null: an absent anamnesis is a normal state, never a 404 (see
    // GetMedicalHistoryUseCase). Nest sends the handler's `null` return as an
    // empty response body (no content-type), so assert on the wire shape
    // rather than `.body`, which supertest defaults to `{}` when empty.
    const getHistory = await request(app.getHttpServer())
      .get(`/api/v1/patients/${created.id}/medical-history`)
      .set('X-Tenant-Host', hostFor(clinic.subdomain))
      .set('Authorization', `Bearer ${clinic.accessToken}`)
      .expect(200);
    expect(getHistory.text).toBe('');
  });
  it('DX-287: alta y edición con el mismo documento escrito distinto dan 409; la clave la guarda la BD', async () => {
    const clinic = await registerAndLogin(app, {
      clinicName: 'Clinica Doc',
      subdomain: 'clinica-doc',
      email: 'owner@clinica-doc.com',
    });
    const send = (req: request.Test) =>
      req
        .set('X-Tenant-Host', hostFor(clinic.subdomain))
        .set('Authorization', `Bearer ${clinic.accessToken}`);
    const create = (docNumber: string) =>
      send(request(app.getHttpServer()).post('/api/v1/patients')).send({
        firstName: 'Doc',
        lastName: docNumber,
        docType: DocType.CC,
        docNumber,
        sex: Sex.F,
      });
    const first = (await create('80.100.200').expect(201))
      .body as PatientResponseBody;
    const keyOf = async (id: string) =>
      (
        await raw.$queryRaw<{ docKey: string | null }[]>`
          SELECT "docKey" FROM "patients" WHERE "id" = ${id}::uuid`
      )[0].docKey;
    expect(await keyOf(first.id)).toBe('80100200');

    const dup = await create('80100200').expect(409);
    expect((dup.body as { message: string }).message).toBe(
      'Ya existe un paciente con ese número de documento.',
    );
    await create(' 80-100-200 ').expect(409);

    const other = (await create('80.100.201').expect(201))
      .body as PatientResponseBody;
    await send(
      request(app.getHttpServer()).patch(`/api/v1/patients/${other.id}`),
    )
      .send({ docNumber: '80 100 200' })
      .expect(409);
    // El propio paciente puede reescribir su documento con otro formato.
    await send(
      request(app.getHttpServer()).patch(`/api/v1/patients/${first.id}`),
    )
      .send({ docNumber: '80100200' })
      .expect(200);
    expect(await keyOf(first.id)).toBe('80100200');
    expect(await keyOf(other.id)).toBe('80100201');
  });
});
