import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  PrismaClient,
  DocType,
  Sex,
  CatalogKind,
  ToothSurface,
} from '@prisma/client';
import { AppModule } from '../src/app.module';

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para el cleanup en
// beforeAll/afterAll — usa DIRECT_URL (rol owner `dentalix`, superuser)
// porque, con RLS aplicado, una conexión sin contexto de tenant (rol
// dentalix_app vía DATABASE_URL) ve 0 filas y no podría limpiar datos de
// corridas anteriores. Ver clinical-history.e2e-spec.ts / patients.e2e-spec.ts
// para el mismo patrón.
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

interface ToothRecordResponseBody {
  id: string;
  tenantId: string;
  patientId: string;
  toothNumber: string;
  surfaces: ToothSurface[];
  kind: CatalogKind;
  status: string;
  recordedAt: string;
}

interface OdontogramGroupResponseBody {
  toothNumber: string;
  records: ToothRecordResponseBody[];
}

async function registerAndLogin(
  app: INestApplication<App>,
  opts: { clinicName: string; subdomain: string; email: string },
): Promise<{ tenantId: string; accessToken: string }> {
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
    .send({
      subdomain: opts.subdomain,
      email: opts.email,
      password: 'S3cret!!',
    })
    .expect(201);
  const loginBody = login.body as LoginResponseBody;

  return {
    tenantId: registerBody.tenantId,
    accessToken: loginBody.accessToken,
  };
}

async function createPatient(
  app: INestApplication<App>,
  accessToken: string,
  docNumber: string,
): Promise<PatientResponseBody> {
  const create = await request(app.getHttpServer())
    .post('/api/v1/patients')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      firstName: 'Odonto',
      lastName: 'Grama',
      docType: DocType.CC,
      docNumber,
      sex: Sex.F,
    })
    .expect(201);
  return create.body as PatientResponseBody;
}

describe('Odontogram (e2e)', () => {
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
    // FK-safe order: tooth_records FKs to patients (and, non-enforced,
    // optionally references dental_catalog_items/clinical_entries) -> patients
    // -> memberships -> users -> tenants.
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

  it('records events per tooth, projects the odontogram, orders the tooth timeline DESC, rejects invalid FDI, is immutable and tenant-isolated', async () => {
    const clinicA = await registerAndLogin(app, {
      clinicName: 'Clinica Odonto A',
      subdomain: 'clinica-odonto-a',
      email: 'owner@clinica-odonto-a.com',
    });
    const patientA = await createPatient(app, clinicA.accessToken, '4001');

    // --- 1. POST several tooth-records across different teeth + surfaces.
    const tooth11Occlusal = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientA.id}/tooth-records`)
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        toothNumber: '11',
        surfaces: [ToothSurface.OCCLUSAL],
        kind: CatalogKind.DIAGNOSIS,
        notes: 'Caries oclusal',
      })
      .expect(201);
    const tooth11OcclusalBody = tooth11Occlusal.body as ToothRecordResponseBody;
    expect(tooth11OcclusalBody.toothNumber).toBe('11');
    expect(tooth11OcclusalBody.surfaces).toEqual([ToothSurface.OCCLUSAL]);
    // performedById comes from the JWT (req.user.sub), never from the body —
    // assert it landed on the record even though it was never sent.
    expect(tooth11OcclusalBody).toHaveProperty('performedById');

    const tooth48Whole = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientA.id}/tooth-records`)
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        toothNumber: '48',
        surfaces: [],
        kind: CatalogKind.PROCEDURE,
        status: 'PLANNED',
        notes: 'Extraccion planificada',
      })
      .expect(201);
    const tooth48WholeBody = tooth48Whole.body as ToothRecordResponseBody;
    expect(tooth48WholeBody.toothNumber).toBe('48');
    expect(tooth48WholeBody.surfaces).toEqual([]);
    expect(tooth48WholeBody.status).toBe('PLANNED');

    // A second, later event on tooth 11 (a different surface) — the
    // timeline for tooth 11 must return this one first (DESC).
    const tooth11Mesial = await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientA.id}/tooth-records`)
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        toothNumber: '11',
        surfaces: [ToothSurface.MESIAL],
        kind: CatalogKind.PROCEDURE,
        status: 'COMPLETED',
        notes: 'Resina mesial',
      })
      .expect(201);
    const tooth11MesialBody = tooth11Mesial.body as ToothRecordResponseBody;

    // --- 2. GET odontogram: grouped projection includes both teeth touched.
    const odontogram = await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientA.id}/odontogram`)
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const odontogramBody = odontogram.body as OdontogramGroupResponseBody[];
    const group11 = odontogramBody.find((g) => g.toothNumber === '11');
    const group48 = odontogramBody.find((g) => g.toothNumber === '48');
    expect(group11).toBeDefined();
    expect(group48).toBeDefined();
    expect(group11?.records.map((r) => r.id).sort()).toEqual(
      [tooth11OcclusalBody.id, tooth11MesialBody.id].sort(),
    );
    expect(group48?.records.map((r) => r.id)).toEqual([tooth48WholeBody.id]);

    // --- 3. GET teeth/11/history: DESC (most recent first).
    const history11 = await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientA.id}/teeth/11/history`)
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const history11Body = history11.body as ToothRecordResponseBody[];
    expect(history11Body).toHaveLength(2);
    expect(history11Body[0].id).toBe(tooth11MesialBody.id);
    expect(history11Body[1].id).toBe(tooth11OcclusalBody.id);
    expect(
      new Date(history11Body[0].recordedAt).getTime(),
    ).toBeGreaterThanOrEqual(new Date(history11Body[1].recordedAt).getTime());

    // --- 4. Invalid FDI on POST -> 400 (DTO-level validation).
    await request(app.getHttpServer())
      .post(`/api/v1/patients/${patientA.id}/tooth-records`)
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({
        toothNumber: '99',
        surfaces: [],
        kind: CatalogKind.DIAGNOSIS,
      })
      .expect(400);

    // --- 5. Immutability is structural: there is no PATCH/DELETE route on
    // the odontogram controller at all (see OdontogramController). A method
    // Express/Nest doesn't recognize on that path 404s.
    await request(app.getHttpServer())
      .patch(
        `/api/v1/patients/${patientA.id}/tooth-records/${tooth11OcclusalBody.id}`,
      )
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .send({ notes: 'intento de edicion' })
      .expect(404);
    await request(app.getHttpServer())
      .delete(
        `/api/v1/patients/${patientA.id}/tooth-records/${tooth11OcclusalBody.id}`,
      )
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(404);

    // --- 6. Tenant isolation: clinic B must not see any of clinic A's data.
    const clinicB = await registerAndLogin(app, {
      clinicName: 'Clinica Odonto B',
      subdomain: 'clinica-odonto-b',
      email: 'owner@clinica-odonto-b.com',
    });

    const odontogramAsB = await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientA.id}/odontogram`)
      .set('Authorization', `Bearer ${clinicB.accessToken}`)
      .expect(200);
    const odontogramAsBBody =
      odontogramAsB.body as OdontogramGroupResponseBody[];
    expect(odontogramAsBBody).toEqual([]);

    const history11AsB = await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientA.id}/teeth/11/history`)
      .set('Authorization', `Bearer ${clinicB.accessToken}`)
      .expect(200);
    const history11AsBBody = history11AsB.body as ToothRecordResponseBody[];
    expect(history11AsBBody).toEqual([]);

    // Sanity: clinic A still sees its own data after clinic B's queries ran.
    const odontogramAsAAgain = await request(app.getHttpServer())
      .get(`/api/v1/patients/${patientA.id}/odontogram`)
      .set('Authorization', `Bearer ${clinicA.accessToken}`)
      .expect(200);
    const odontogramAsAAgainBody =
      odontogramAsAAgain.body as OdontogramGroupResponseBody[];
    expect(odontogramAsAAgainBody.some((g) => g.toothNumber === '11')).toBe(
      true,
    );
  });
});
