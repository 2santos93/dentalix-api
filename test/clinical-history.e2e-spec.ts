import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaClient, DocType, Sex, CatalogKind } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hostFor } from './support/tenant-host';

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para el cleanup en
// beforeAll/afterAll — usa DIRECT_URL (rol owner `dentalix`, superuser)
// porque, con RLS aplicado, una conexión sin contexto de tenant (rol
// dentalix_app vía DATABASE_URL) ve 0 filas y no podría limpiar datos de
// corridas anteriores. Ver patients.e2e-spec.ts / auth.e2e-spec.ts para el
// mismo patrón.
const raw = new PrismaClient({
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
}

interface MedicalHistoryResponseBody {
  id: string;
  tenantId: string;
  patientId: string;
  version: number;
  allergies: string | null;
  notes: string | null;
}

interface ClinicalEntryResponseBody {
  id: string;
  tenantId: string;
  patientId: string;
  entryDate: string;
  reason: string | null;
  notes: string;
}

interface CatalogItemResponseBody {
  id: string;
  tenantId: string;
  code: string;
  kind: CatalogKind;
  labelEs: string;
  color: string;
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
      password: 'S3cret!!',
      fullName: 'Dr. Owner',
    })
    .expect(201);
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
      firstName: 'Historia',
      lastName: 'Clinica',
      docType: DocType.CC,
      docNumber,
      sex: Sex.F,
    })
    .expect(201);
  return create.body as PatientResponseBody;
}

describe('Clinical history (e2e)', () => {
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
    // FK-safe order: children of patient -> patients -> memberships -> users
    // -> tenants. medical_history_versions / clinical_entries FK to patients;
    // dental_catalog_items only FKs to tenants.
    await raw.medicalHistoryVersion.deleteMany();
    await raw.clinicalEntry.deleteMany();
    await raw.dentalCatalogItem.deleteMany();
    await raw.patient.deleteMany();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
  });

  afterAll(async () => {
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

  it('versions medical history, orders clinical entries, enforces catalog kind filtering and tenant isolation', async () => {
    const clinicA = await registerAndLogin(app, {
      clinicName: 'Clinica Historia A',
      subdomain: 'clinica-historia-a',
      email: 'owner@clinica-historia-a.com',
    });
    const patientA = await createPatient(
      app,
      clinicA.accessToken,
      clinicA.subdomain,
      '3001',
    );

    // --- 1. Medical history: GET before any PUT is 200 + empty body (absent
    // anamnesis is a normal state, never a 404 — see GetMedicalHistoryUseCase).
    // Nest sends the handler's `null` return as an empty response (no
    // content-type, content-length 0), not a JSON "null" literal — assert on
    // that real wire shape rather than `.body`, which supertest defaults to
    // `{}` when there is nothing to parse.
    const getBeforeAny = await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientA.id}/medical-history`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    expect(getBeforeAny.text).toBe('');

    // --- 2. Medical history versioning: PUT v1, PUT v2, GET returns v2 with
    // version incremented (append-only, never an update-in-place).
    const putV1 = await request(app.getHttpServer())
      .put(`/api/v1/patients/${patientA.id}/medical-history`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({ allergies: 'Penicilina', notes: 'Version 1' })
      .expect(200);
    const putV1Body = putV1.body as MedicalHistoryResponseBody;
    expect(putV1Body.version).toBe(1);
    expect(putV1Body.allergies).toBe('Penicilina');
    expect(putV1Body.notes).toBe('Version 1');

    const putV2 = await request(app.getHttpServer())
      .put(`/api/v1/patients/${patientA.id}/medical-history`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({ allergies: 'Ninguna conocida', notes: 'Version 2' })
      .expect(200);
    const putV2Body = putV2.body as MedicalHistoryResponseBody;
    expect(putV2Body.version).toBe(2);
    expect(putV2Body.id).not.toBe(putV1Body.id); // append-only: a new row, not an update

    const getLatest = await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientA.id}/medical-history`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const getLatestBody = getLatest.body as MedicalHistoryResponseBody;
    expect(getLatestBody.version).toBe(2);
    expect(getLatestBody.allergies).toBe('Ninguna conocida');
    expect(getLatestBody.notes).toBe('Version 2');

    // --- 3. Clinical entries: POST two entries out of chronological insert
    // order, GET must return them ordered by entryDate DESC.
    const olderEntry = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientA.id}/clinical-entries`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        entryDate: '2026-01-10T10:00:00.000Z',
        reason: 'Control',
        notes: 'Entrada mas antigua (creada segunda)',
      })
      .expect(201);
    const olderEntryBody = olderEntry.body as ClinicalEntryResponseBody;

    const newerEntry = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientA.id}/clinical-entries`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        entryDate: '2026-05-20T10:00:00.000Z',
        reason: 'Limpieza',
        notes: 'Entrada mas reciente (creada primero)',
      })
      .expect(201);
    const newerEntryBody = newerEntry.body as ClinicalEntryResponseBody;

    const listEntries = await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientA.id}/clinical-entries`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const listEntriesBody = listEntries.body as ClinicalEntryResponseBody[];
    const ourEntries = listEntriesBody.filter(
      (e) => e.id === olderEntryBody.id || e.id === newerEntryBody.id,
    );
    expect(ourEntries).toHaveLength(2);
    // Explicit DESC-by-entryDate assertion: newest first, regardless of
    // insertion order (newerEntry was created second but sorts first).
    expect(ourEntries[0].id).toBe(newerEntryBody.id);
    expect(ourEntries[1].id).toBe(olderEntryBody.id);
    expect(new Date(ourEntries[0].entryDate).getTime()).toBeGreaterThan(
      new Date(ourEntries[1].entryDate).getTime(),
    );

    // --- Immutability is structural: there is no PATCH/DELETE route on the
    // clinical-entries controller at all (see ClinicalEntriesController).
    // A method Express/Nest doesn't recognize on that path 404s.
    await request(app.getHttpServer())
      .delete(
        `/api/v1/patients/${patientA.id}/clinical-entries/${olderEntryBody.id}`,
      )
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .patch(
        `/api/v1/patients/${patientA.id}/clinical-entries/${olderEntryBody.id}`,
      )
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({ notes: 'intento de edicion' })
      .expect(404);

    // --- 4. Catalog: POST a DIAGNOSIS item, GET includes it, kind=PROCEDURE
    // filter excludes it.
    const createCatalogItem = await request(app.getHttpServer())
      .post('/api/v1/catalog/items')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        code: 'CARIES-001',
        kind: CatalogKind.DIAGNOSIS,
        labelEs: 'Caries',
        color: '#1A2B3C',
      })
      .expect(201);
    const catalogItemBody = createCatalogItem.body as CatalogItemResponseBody;
    expect(catalogItemBody.kind).toBe(CatalogKind.DIAGNOSIS);
    expect(catalogItemBody.color).toBe('#1A2B3C');

    const listCatalog = await request(app.getHttpServer())
      .get('/api/v1/catalog/items')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const listCatalogBody = listCatalog.body as CatalogItemResponseBody[];
    expect(listCatalogBody.some((i) => i.id === catalogItemBody.id)).toBe(true);

    const listCatalogProcedureOnly = await request(app.getHttpServer())
      .get('/api/v1/catalog/items?kind=PROCEDURE')
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const listCatalogProcedureOnlyBody =
      listCatalogProcedureOnly.body as CatalogItemResponseBody[];
    expect(
      listCatalogProcedureOnlyBody.some((i) => i.id === catalogItemBody.id),
    ).toBe(false);

    // --- 5. Tenant isolation: clinic B must not see any of clinic A's data.
    const clinicB = await registerAndLogin(app, {
      clinicName: 'Clinica Historia B',
      subdomain: 'clinica-historia-b',
      email: 'owner@clinica-historia-b.com',
    });

    // Medical history: RLS scopes medical_history_versions by tenant, so
    // clinic B querying clinic A's patientId sees 0 rows -> 200 + empty body,
    // the same "absent anamnesis" shape as before any PUT (never a 404 that
    // would leak whether the patient id exists).
    const getHistoryAsB = await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientA.id}/medical-history`)
      .set('X-Tenant-Host', hostFor(clinicB.subdomain))
      .set('Authorization', `Bearer ${clinicB.accessToken}`)
      .expect(200);
    expect(getHistoryAsB.text).toBe('');

    // Clinical entries: clinic B's list for clinic A's patientId is empty.
    const listEntriesAsB = await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientA.id}/clinical-entries`)
      .set('X-Tenant-Host', hostFor(clinicB.subdomain))
      .set('Authorization', `Bearer ${clinicB.accessToken}`)
      .expect(200);
    const listEntriesAsBBody =
      listEntriesAsB.body as ClinicalEntryResponseBody[];
    expect(listEntriesAsBBody).toEqual([]);

    // Catalog: clinic B's list must not include clinic A's item, even with
    // no kind filter.
    const listCatalogAsB = await request(app.getHttpServer())
      .get('/api/v1/catalog/items')
      .set('X-Tenant-Host', hostFor(clinicB.subdomain))
      .set('Authorization', `Bearer ${clinicB.accessToken}`)
      .expect(200);
    const listCatalogAsBBody = listCatalogAsB.body as CatalogItemResponseBody[];
    expect(listCatalogAsBBody.some((i) => i.id === catalogItemBody.id)).toBe(
      false,
    );

    // Sanity: clinic A still sees its own data after clinic B's queries ran.
    const getHistoryAsAAgain = await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientA.id}/medical-history`)
      .set('X-Tenant-Host', hostFor(clinicA.subdomain))
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const getHistoryAsAAgainBody =
      getHistoryAsAAgain.body as MedicalHistoryResponseBody;
    expect(getHistoryAsAAgainBody.version).toBe(2);
  });
});
