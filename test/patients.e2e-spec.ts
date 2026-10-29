import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Prisma, PrismaClient, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_BOGOTA_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
  registerBody as clinicRegisterBody,
  type RegionalFixture,
} from './support/location-fixtures';
import { DOCUMENT_TYPES } from '../src/modules/patients/domain/document-type';
import { legacyStoredDocType } from '../src/modules/patients/domain/legacy-doc-type';
import { DocumentTypeNamesReader } from '../src/modules/patients/domain/ports/document-type-names-repository.port';

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
  opts: {
    clinicName: string;
    subdomain: string;
    email: string;
    fixture?: RegionalFixture;
  },
): Promise<{ tenantId: string; accessToken: string; subdomain: string }> {
  const register = await registerVerified(
    app,
    clinicRegisterBody(opts.fixture ?? REGIONAL_BOGOTA_FIXTURE, {
      clinicName: opts.clinicName,
      subdomain: opts.subdomain,
      email: opts.email,
      password: 'S3cret!!',
      fullName: 'Dr. Owner',
    }),
  );
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
        docType: 'NATIONAL_ID',
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
  });

  describe('DX-322 fase 1: el texto libre de aseguradora anterior a DX-153', () => {
    let clinic: { tenantId: string; accessToken: string; subdomain: string };
    let patientId: string;

    beforeAll(async () => {
      clinic = await registerAndLogin(app, {
        clinicName: 'Clinica DX322',
        subdomain: 'clinica-dx322',
        email: 'owner@clinica-dx322.com',
      });
      patientId = (
        await raw.patient.create({
          data: {
            tenantId: clinic.tenantId,
            firstName: 'Legada',
            lastName: 'DX322',
          },
        })
      ).id;
      // La columna sigue en la BD hasta la fase 2; el cliente Prisma ya no la
      // ve, así que se siembra en crudo.
      await raw.$executeRaw`
        UPDATE patients SET "insurerEps" = 'Texto anterior' WHERE id = ${patientId}::uuid`;
    });

    function insurerEpsInDb(): Promise<{ insurerEps: string | null }[]> {
      return raw.$queryRaw`
        SELECT "insurerEps" FROM patients WHERE id = ${patientId}::uuid`;
    }

    it('GET /patients/:id has no insurerEps key', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/patients/${patientId}`)
        .set('X-Tenant-Host', hostFor(clinic.subdomain))
        .set('Authorization', `Bearer ${clinic.accessToken}`)
        .expect(200);
      expect(res.body).not.toHaveProperty('insurerEps');
    });

    it('PATCH with insurerEps is 200 and ignored', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/patients/${patientId}`)
        .set('X-Tenant-Host', hostFor(clinic.subdomain))
        .set('Authorization', `Bearer ${clinic.accessToken}`)
        .send({ occupation: 'Docente', insurerEps: 'Sura' })
        .expect(200);
      const body = res.body as Record<string, unknown>;
      expect(body.occupation).toBe('Docente');
      expect(body).not.toHaveProperty('insurerEps');
      expect(await insurerEpsInDb()).toEqual([
        { insurerEps: 'Texto anterior' },
      ]);
    });
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
        docType: 'NATIONAL_ID',
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
          .send({ docType: 'NATIONAL_ID', sex: Sex.M, ...body })
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
        docType: 'NATIONAL_ID',
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
        docType: 'NATIONAL_ID',
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
        docType: 'NATIONAL_ID',
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
        docType: 'NATIONAL_ID',
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

  // DX-327: tipos de documento genéricos, nombre libre (R7), entrada anterior
  // (R9), fase 1 en la BD (R4–R5) y nombre visible (R17). La sede es
  // REGIONAL_TOKYO_FIXTURE: el país de la sede lo obliga el enum hasta
  // DX-312; no decide nada.
  describe('DX-327: tipos de documento genéricos', () => {
    interface DocPatient {
      id: string;
      docType: string;
      docTypeLabel: string | null;
      docTypeName: string;
      docNumber: string | null;
    }
    interface DocRow {
      documentType: string;
      docType: string;
      docTypeLabel: string | null;
      docKey: string | null;
    }

    let clinic: { tenantId: string; accessToken: string; subdomain: string };
    let seq = 0;

    const send = (req: request.Test) =>
      req
        .set('X-Tenant-Host', hostFor(clinic.subdomain))
        .set('Authorization', `Bearer ${clinic.accessToken}`);
    const create = (body: Record<string, unknown>) =>
      send(request(app.getHttpServer()).post('/api/v1/patients')).send({
        firstName: 'Documento',
        lastName: `Prueba ${++seq}`,
        sex: Sex.F,
        ...body,
      });
    const patch = (id: string, body: Record<string, unknown>) =>
      send(request(app.getHttpServer()).patch(`/api/v1/patients/${id}`))
        .send(body)
        .expect(200);
    const detail = async (id: string) =>
      (
        await send(
          request(app.getHttpServer()).get(`/api/v1/patients/${id}`),
        ).expect(200)
      ).body as DocPatient;
    const listed = async (id: string, query: string) => {
      const res = await send(
        request(app.getHttpServer()).get('/api/v1/patients'),
      )
        .query({ query })
        .expect(200);
      return (res.body as { items: DocPatient[] }).items.find(
        (p) => p.id === id,
      );
    };
    const sqlRow = async (id: string): Promise<DocRow> => {
      const [row] = await raw.$queryRaw<DocRow[]>`
        SELECT "documentType"::text AS "documentType", "docType"::text AS "docType",
               "docTypeLabel", "docKey"
          FROM "patients" WHERE "id" = ${id}::uuid`;
      return row;
    };
    const setNames = (names: Record<string, string | null>) =>
      send(
        request(app.getHttpServer()).put(
          '/api/v1/patients/document-type-names',
        ),
      )
        .send({ names })
        .expect(200);

    beforeAll(async () => {
      clinic = await registerAndLogin(app, {
        clinicName: 'Clinica Documentos',
        subdomain: 'clinica-documentos',
        email: 'owner@clinica-documentos.com',
        fixture: REGIONAL_TOKYO_FIXTURE,
      });
    });

    it('every document type round-trips through create, edit and SQL', async () => {
      for (const [i, docType] of DOCUMENT_TYPES.entries()) {
        const res = await create({ docType, docNumber: `RX-10${i}` }).expect(
          201,
        );
        const created = res.body as DocPatient;
        expect(created).toMatchObject({ docType, docTypeLabel: null });
        expect(await detail(created.id)).toMatchObject({
          docType,
          docTypeLabel: null,
        });
        // Fase 1: el genérico y la proyección anterior para las réplicas
        // anteriores, que leen solo "docType" (R5, §7).
        expect(await sqlRow(created.id)).toMatchObject({
          documentType: docType,
          docType: legacyStoredDocType(docType),
          docTypeLabel: null,
        });

        const next = DOCUMENT_TYPES[(i + 1) % DOCUMENT_TYPES.length];
        await patch(created.id, { docType: next });
        expect(await detail(created.id)).toMatchObject({
          docType: next,
          docTypeLabel: null,
        });
        expect(await sqlRow(created.id)).toMatchObject({
          documentType: next,
          docType: legacyStoredDocType(next),
          docTypeLabel: null,
        });
      }
    });

    it('a national number with a letter prefix and separators is stored as written with its free label', async () => {
      const prefixed = (
        await create({
          docType: 'NATIONAL_ID',
          docNumber: 'V-12345678',
          docTypeLabel: 'ID local',
        }).expect(201)
      ).body as DocPatient;
      expect(await detail(prefixed.id)).toMatchObject({
        docType: 'NATIONAL_ID',
        docNumber: 'V-12345678',
        docTypeLabel: 'ID local',
        docTypeName: 'ID local',
      });
      expect(await sqlRow(prefixed.id)).toMatchObject({
        docKey: 'V12345678',
        docTypeLabel: 'ID local',
      });

      const other = (
        await create({
          docType: 'NATIONAL_ID',
          docNumber: 'E-81234567',
        }).expect(201)
      ).body as DocPatient;
      expect(await detail(other.id)).toMatchObject({
        docNumber: 'E-81234567',
        docTypeLabel: null,
      });
      expect((await sqlRow(other.id)).docKey).toBe('E81234567');
    });

    it('a free label is stored normalized, comes back in the detail and the list, and is cleared only when the generic type changes without one', async () => {
      const created = (
        await create({
          docType: 'NATIONAL_ID',
          docNumber: 'RX-2001',
          docTypeLabel: '  ID   local ',
        }).expect(201)
      ).body as DocPatient;
      expect(created.docTypeLabel).toBe('ID local');
      expect(await detail(created.id)).toMatchObject({
        docTypeLabel: 'ID local',
      });
      expect(await listed(created.id, 'RX-2001')).toMatchObject({
        docTypeLabel: 'ID local',
        docTypeName: 'ID local',
      });
      expect((await sqlRow(created.id)).docTypeLabel).toBe('ID local');

      // El mismo tipo, u otro campo: se queda.
      await patch(created.id, { docType: 'NATIONAL_ID' });
      await patch(created.id, { firstName: 'Documento' });
      expect((await detail(created.id)).docTypeLabel).toBe('ID local');

      // Otro tipo sin etiqueta: se borra.
      await patch(created.id, { docType: 'PASSPORT' });
      expect(await detail(created.id)).toMatchObject({
        docType: 'PASSPORT',
        docTypeLabel: null,
      });
      expect((await sqlRow(created.id)).docTypeLabel).toBeNull();

      // Otro tipo con etiqueta: la nueva; null la quita.
      await patch(created.id, { docType: 'TAX_ID', docTypeLabel: 'Fiscal A' });
      expect((await detail(created.id)).docTypeLabel).toBe('Fiscal A');
      await patch(created.id, { docTypeLabel: null });
      expect((await detail(created.id)).docTypeLabel).toBeNull();

      const tooLong = await send(
        request(app.getHttpServer()).patch(`/api/v1/patients/${created.id}`),
      )
        .send({ docTypeLabel: 'x'.repeat(41) })
        .expect(400);
      expect((tooLong.body as { message: string }).message).toBe(
        'El nombre del documento admite hasta 40 caracteres.',
      );
    });

    it('legacy codes in the body are accepted as their generic type with no label during the rollout', async () => {
      for (const [code, type] of [
        ['CC', 'NATIONAL_ID'],
        ['TI', 'NATIONAL_ID'],
        ['CE', 'RESIDENCE_PERMIT'],
      ] as const) {
        const created = (await create({ docType: code }).expect(201))
          .body as DocPatient;
        expect(created).toMatchObject({ docType: type, docTypeLabel: null });
        expect(await sqlRow(created.id)).toMatchObject({
          documentType: type,
          docTypeLabel: null,
        });
      }
      const labelled = (
        await create({ docType: 'CE', docTypeLabel: 'ID local' }).expect(201)
      ).body as DocPatient;
      expect(labelled).toMatchObject({
        docType: 'RESIDENCE_PERMIT',
        docTypeLabel: 'ID local',
      });
      // Una edición anterior que reenvía su código no cambia el tipo genérico:
      // la etiqueta se queda (pre-flight I1).
      await patch(labelled.id, { docType: 'CE', phone: '+81 3 5555 0100' });
      expect(await detail(labelled.id)).toMatchObject({
        docType: 'RESIDENCE_PERMIT',
        docTypeLabel: 'ID local',
      });
    });

    it("docTypeName is the patient's label, then the clinic's local name, then the generic name", async () => {
      const plain = (
        await create({ docType: 'NATIONAL_ID', docNumber: 'RX-3001' }).expect(
          201,
        )
      ).body as DocPatient;
      const labelled = (
        await create({
          docType: 'NATIONAL_ID',
          docNumber: 'RX-3002',
          docTypeLabel: 'ID local',
        }).expect(201)
      ).body as DocPatient;
      const parties = `/api/v1/patients/${plain.id}/responsible-parties`;
      await send(request(app.getHttpServer()).post(parties))
        .send({
          fullName: 'Contacto A',
          docType: 'NATIONAL_ID',
          relationship: 'OTHER',
        })
        .expect(201);
      await send(request(app.getHttpServer()).post(parties))
        .send({ responsiblePatientId: labelled.id, relationship: 'OTHER' })
        .expect(201);
      const contactName = async () => {
        const res = await send(
          request(app.getHttpServer()).get(parties),
        ).expect(200);
        const body = res.body as {
          parties: {
            kind: string;
            docTypeName: string | null;
            responsiblePatient: { docTypeName: string } | null;
          }[];
        };
        return body.parties.map((p) => [
          p.kind,
          p.docTypeName,
          p.responsiblePatient?.docTypeName ?? null,
        ]);
      };

      expect(plain.docTypeName).toBe('Documento nacional');
      expect((await detail(plain.id)).docTypeName).toBe('Documento nacional');
      expect((await listed(plain.id, 'RX-3001'))?.docTypeName).toBe(
        'Documento nacional',
      );
      expect(await contactName()).toEqual([
        ['CONTACT', 'Documento nacional', null],
        ['PATIENT', 'ID local', 'ID local'],
      ]);

      await setNames({ NATIONAL_ID: 'Documento A' });
      try {
        expect((await detail(plain.id)).docTypeName).toBe('Documento A');
        expect((await listed(plain.id, 'RX-3001'))?.docTypeName).toBe(
          'Documento A',
        );
        expect((await detail(labelled.id)).docTypeName).toBe('ID local');
        expect(await contactName()).toEqual([
          ['CONTACT', 'Documento A', null],
          ['PATIENT', 'ID local', 'ID local'],
        ]);
      } finally {
        await setNames({});
      }
    });

    it('the clinic names are read once per request, not once per row', async () => {
      for (let i = 0; i < 3; i += 1) {
        await create({ docType: 'OTHER', docNumber: `RX-40${i}` }).expect(201);
      }
      const reader = app.get(DocumentTypeNamesReader, { strict: false });
      const get = jest.spyOn(reader, 'get');
      try {
        const res = await send(
          request(app.getHttpServer()).get('/api/v1/patients'),
        )
          .query({ query: 'RX-40' })
          .expect(200);
        expect((res.body as { items: unknown[] }).items).toHaveLength(3);
        expect(get).toHaveBeenCalledTimes(1);
      } finally {
        get.mockRestore();
      }
    });

    it('legacy rows written by an older API read back generic with no label', async () => {
      const [{ id }] = await raw.$queryRaw<{ id: string }[]>`
        INSERT INTO "patients" ("id","tenantId","firstName","lastName","docType","docNumber","updatedAt")
        VALUES (gen_random_uuid(), ${clinic.tenantId}::uuid, 'Anterior', 'Fila', 'TI', 'RX-5001', now())
        RETURNING "id"::text AS "id"`;
      expect(await detail(id)).toMatchObject({
        docType: 'NATIONAL_ID',
        docTypeLabel: null,
        docTypeName: 'Documento nacional',
      });
      expect(await listed(id, 'RX-5001')).toMatchObject({
        docType: 'NATIONAL_ID',
        docTypeLabel: null,
      });
    });

    it('the type is required and has no default', async () => {
      const res = await create({ docNumber: 'RX-6001' }).expect(400);
      expect(JSON.stringify(res.body)).toContain(
        'El tipo de documento debe ser uno de: NATIONAL_ID, PASSPORT, RESIDENCE_PERMIT, TAX_ID, OTHER.',
      );
      await create({ docType: 'constructor' }).expect(400);
    });

    it('a full edit that resends the same type keeps the label', async () => {
      const created = (
        await create({
          docType: 'PASSPORT',
          docNumber: 'RX-7001',
          docTypeLabel: 'ID local',
        }).expect(201)
      ).body as DocPatient & Record<string, unknown>;
      // Como cualquier cliente: todos los campos del formulario, con el mismo
      // tipo y sin `docTypeLabel`.
      await patch(created.id, {
        firstName: 'Documento',
        lastName: 'Completo',
        docType: 'PASSPORT',
        docNumber: 'RX-7001',
        birthDate: '1990-05-01',
        sex: Sex.M,
        phone: '+81 3 5555 0101',
        email: 'completo@example.com',
        address: 'Calle 1',
        notes: null,
        maritalStatus: null,
        occupation: null,
        physicianName: null,
        physicianPhone: null,
        emergencyContactName: null,
        emergencyContactRelationship: null,
        emergencyContactPhone: null,
      });
      expect(await detail(created.id)).toMatchObject({
        lastName: 'Completo',
        docType: 'PASSPORT',
        docTypeLabel: 'ID local',
      });
    });

    it('PATCH docTypeLabel is audited by field name only', async () => {
      const created = (
        await create({ docType: 'OTHER', docNumber: 'RX-8001' }).expect(201)
      ).body as DocPatient;
      await patch(created.id, { docTypeLabel: 'Documento secreto' });
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: clinic.tenantId,
          patientId: created.id,
          action: 'UPDATE',
        },
        select: { metadata: true },
      });
      expect(events).toHaveLength(1);
      expect(
        (events[0].metadata as { changedFields: string[] }).changedFields,
      ).toEqual(['docTypeLabel']);
      expect(JSON.stringify(events)).not.toContain('secreto');
    });
  });
});
