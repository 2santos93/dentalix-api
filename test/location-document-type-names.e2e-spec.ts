import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  SEEDED_PASSWORD,
  loginAs,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  REGIONAL_BERLIN_FIXTURE,
  REGIONAL_NEW_YORK_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
  locationBody,
  registerBody,
} from './support/location-fixtures';
import { registerVerified } from './support/register-verified';
import { hostFor } from './support/tenant-host';

// DX-524 en HTTP real: cada sede puede poner su propio nombre a los tipos de
// documento (PATCH /locations/:id, solo ADMIN, auditado). Sin nombre propio
// hereda el de la clínica (DX-327) y, sin este, el genérico. Las pantallas
// usan la sede activa; los documentos, la suya, y lo ya emitido no cambia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface LocationItem {
  id: string;
  name: string;
  docTypeNames: Record<string, string | null>;
}

interface AuditItem {
  action: string;
  resourceId: string | null;
  metadata: {
    changedFields?: string[];
    configChange?: {
      before?: Record<string, string | null>;
      after?: Record<string, string | null>;
    };
  };
}

describe('Nombre del documento por sede (e2e, DX-524)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let locA: string;
  let locB: string;
  let locC: string;
  let dentist: string;
  let adminA: string;

  const api = () => request(app.getHttpServer());
  const as = (
    req: request.Test,
    token: string,
    opts: { host?: string; location?: string } = {},
  ) => {
    const r = req
      .set('X-Tenant-Host', opts.host ?? clinic.host)
      .set('Authorization', `Bearer ${token}`);
    return opts.location ? r.set('X-Location-Id', opts.location) : r;
  };
  const patchLocation = (
    id: string,
    body: object,
    token = clinic.adminToken,
    host = clinic.host,
  ) => as(api().patch(`/api/v1/locations/${id}`), token, { host }).send(body);
  const locations = async (): Promise<LocationItem[]> =>
    (
      (await as(api().get('/api/v1/locations'), clinic.adminToken).expect(200))
        .body as LocationItem[]
    ).slice();
  const namesOf = async (id: string) =>
    (await locations()).find((l) => l.id === id)!.docTypeNames;
  const get = <T>(path: string, token: string, location?: string) =>
    as(api().get(`/api/v1${path}`), token, { location })
      .expect(200)
      .then((res) => res.body as T);
  const post = <T>(
    path: string,
    body: object,
    token: string,
    location?: string,
  ) =>
    as(api().post(`/api/v1${path}`), token, { location })
      .send(body)
      .expect(201)
      .then((res) => res.body as T);

  async function register(subdomain: string): Promise<Clinic> {
    const email = `owner@${subdomain}.test`;
    const res = await registerVerified(
      app,
      registerBody(REGIONAL_TOKYO_FIXTURE, {
        clinicName: `Clinica ${subdomain}`,
        subdomain,
        email,
        password: SEEDED_PASSWORD,
        fullName: 'Dr. Owner',
      }),
    );
    const { tenantId, userId } = res.body as {
      tenantId: string;
      userId: string;
    };
    const host = hostFor(subdomain);
    return {
      tenantId,
      adminUserId: userId,
      subdomain,
      host,
      adminToken: await loginAs(app, host, email),
    };
  }

  const locationEvents = async (id: string): Promise<AuditItem[]> =>
    (
      (
        await as(
          api().get(
            `/api/v1/audit-events?resourceType=LOCATION&resourceId=${id}`,
          ),
          clinic.adminToken,
        ).expect(200)
      ).body as { items: AuditItem[] }
    ).items.filter((e) => e.action === 'UPDATE' && e.resourceId === id);

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await register('dx524-names');
    other = await register('dx524-names-otra');
    const created = async (name: string, fixture: object) =>
      (
        await as(api().post('/api/v1/locations'), clinic.adminToken)
          .send(locationBody(fixture as never, { name }))
          .expect(201)
      ).body as { id: string };
    locA = (await locations())[0].id;
    locB = (await created('Sede B', REGIONAL_NEW_YORK_FIXTURE)).id;
    locC = (await created('Sede C', REGIONAL_BERLIN_FIXTURE)).id;
    adminA = clinic.adminToken;
    const member = await seedMember(raw, clinic, ClinicRole.DENTIST);
    dentist = await loginAs(app, clinic.host, member.email);
    await raw.clinicMembership.updateMany({
      where: { tenantId: clinic.tenantId, userId: member.userId },
      data: { professionalLicense: 'RM-0524' },
    });
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('every location starts without its own names', async () => {
    for (const l of await locations()) {
      expect(Object.values(l.docTypeNames)).toEqual([
        null,
        null,
        null,
        null,
        null,
      ]);
    }
  });

  it('only an ADMIN changes them; a non-ADMIN gets 403 and nothing changes', async () => {
    await patchLocation(
      locB,
      { docTypeNames: { NATIONAL_ID: 'X1' } },
      dentist,
    ).expect(403);
    expect((await namesOf(locB)).NATIONAL_ID).toBeNull();
  });

  it('PATCH changes only the types sent and null or empty inherits again', async () => {
    await patchLocation(locB, {
      docTypeNames: {
        NATIONAL_ID: '  Documento   de B ',
        PASSPORT: 'Pasaporte B',
      },
    }).expect(200);
    expect(await namesOf(locB)).toMatchObject({
      NATIONAL_ID: 'Documento de B',
      PASSPORT: 'Pasaporte B',
      TAX_ID: null,
    });
    await patchLocation(locB, { docTypeNames: { PASSPORT: '' } }).expect(200);
    expect(await namesOf(locB)).toMatchObject({
      NATIONAL_ID: 'Documento de B',
      PASSPORT: null,
    });
    // Una petición sin el campo no los toca.
    await patchLocation(locB, { phone: '+1 555 0100' }).expect(200);
    expect((await namesOf(locB)).NATIONAL_ID).toBe('Documento de B');
    // Otra sede no cambió.
    expect((await namesOf(locC)).NATIONAL_ID).toBeNull();
  });

  it('is 400 and saves nothing for a repeated name, a generic one of another type or one over 60', async () => {
    await patchLocation(locC, {
      docTypeNames: { NATIONAL_ID: 'Mismo', PASSPORT: 'mismo' },
    }).expect(400);
    await patchLocation(locC, {
      docTypeNames: { NATIONAL_ID: 'Pasaporte' },
    }).expect(400);
    await patchLocation(locC, {
      docTypeNames: { NATIONAL_ID: 'a'.repeat(61) },
    }).expect(400);
    expect((await namesOf(locC)).NATIONAL_ID).toBeNull();
  });

  it('audits the change with before and after of the types that changed, and not an unchanged one', async () => {
    await patchLocation(locC, {
      docTypeNames: { NATIONAL_ID: 'Documento C' },
    }).expect(200);
    await patchLocation(locC, {
      docTypeNames: { NATIONAL_ID: 'Documento C' },
    }).expect(200);
    await patchLocation(locC, {
      docTypeNames: { NATIONAL_ID: 'Documento C2' },
    }).expect(200);
    const events = (await locationEvents(locC)).filter(
      (e) => e.metadata.configChange,
    );
    expect(events.map((e) => e.metadata.configChange)).toEqual([
      {
        before: { docTypeNameNationalId: 'Documento C' },
        after: { docTypeNameNationalId: 'Documento C2' },
      },
      {
        before: { docTypeNameNationalId: null },
        after: { docTypeNameNationalId: 'Documento C' },
      },
    ]);
  });

  it('does not touch another clinic', async () => {
    const theirs = (
      await as(api().get('/api/v1/locations'), other.adminToken, {
        host: other.host,
      }).expect(200)
    ).body as LocationItem[];
    expect(theirs.map((l) => l.docTypeNames.NATIONAL_ID)).toEqual([null]);
    // Y una sede de otra clínica no se edita desde esta.
    await patchLocation(theirs[0].id, {
      docTypeNames: { NATIONAL_ID: 'Intruso' },
    }).expect(404);
  });

  describe('where the name shows', () => {
    let patientId: string;
    let catalogItemId: string;

    beforeAll(async () => {
      // Clínica: «Documento clínica»; A hereda; B tiene el suyo; C el suyo.
      await as(api().put('/api/v1/patients/document-type-names'), adminA)
        .send({ names: { NATIONAL_ID: 'Documento clínica' } })
        .expect(200);
      await patchLocation(locB, {
        docTypeNames: { NATIONAL_ID: 'Documento B' },
      }).expect(200);
      await patchLocation(locC, {
        docTypeNames: { NATIONAL_ID: 'Documento C' },
      }).expect(200);
      patientId = (
        await post<{ id: string }>(
          '/patients',
          {
            firstName: 'Ana',
            lastName: 'Sedes',
            docType: 'NATIONAL_ID',
            docNumber: 'S-524',
            sex: 'F',
          },
          adminA,
        )
      ).id;
      catalogItemId = (
        await post<{ id: string }>(
          '/catalog/items',
          {
            code: 'DX524-PROC',
            kind: 'PROCEDURE',
            labelEs: 'Procedimiento',
            color: '#336699',
            defaultPrice: 100,
          },
          adminA,
        )
      ).id;
    });

    it('a screen shows the active location name, the clinic name with all locations, and the generic one when neither has it', async () => {
      const at = async (location?: string) =>
        (
          await get<{ docTypeName: string }>(
            `/patients/${patientId}`,
            adminA,
            location,
          )
        ).docTypeName;
      expect(await at(locB)).toBe('Documento B');
      expect(await at(locC)).toBe('Documento C');
      expect(await at(locA)).toBe('Documento clínica');
      expect(await at()).toBe('Documento clínica');
      await as(api().put('/api/v1/patients/document-type-names'), adminA)
        .send({ names: {} })
        .expect(200);
      expect(await at(locA)).toBe('Documento nacional');
      expect(await at(locB)).toBe('Documento B');
      await as(api().put('/api/v1/patients/document-type-names'), adminA)
        .send({ names: { NATIONAL_ID: 'Documento clínica' } })
        .expect(200);
    });

    it('GET /patients/document-type-names keeps the clinic names in `names` and adds what the active location uses in `effective`', async () => {
      const read = (location?: string) =>
        get<{
          names: Record<string, string | null>;
          effective: Record<string, string | null>;
        }>('/patients/document-type-names', adminA, location);
      const inB = await read(locB);
      expect(inB.names.NATIONAL_ID).toBe('Documento clínica');
      expect(inB.effective.NATIONAL_ID).toBe('Documento B');
      expect((await read(locA)).effective.NATIONAL_ID).toBe(
        'Documento clínica',
      );
      expect((await read()).effective.NATIONAL_ID).toBe('Documento clínica');
    });

    it('a prescription freezes the name of the location that issues it, and a later rename changes nothing', async () => {
      const rx = (location: string) =>
        post<{ id: string; patientDocument: string | null }>(
          `/patients/${patientId}/prescriptions`,
          {
            items: [
              {
                activeIngredient: 'Amoxicilina',
                concentration: '500 mg',
                pharmaceuticalForm: 'Cápsula',
                route: 'Oral',
                dose: '1 cápsula',
                frequency: 'Cada 8 horas',
                durationDays: 7,
                totalQuantity: 21,
                quantityUnit: 'cápsulas',
              },
            ],
          },
          dentist,
          location,
        );
      const inB = await rx(locB);
      const inA = await rx(locA);
      expect(inB.patientDocument).toBe('Documento B S-524');
      expect(inA.patientDocument).toBe('Documento clínica S-524');
      await patchLocation(locB, {
        docTypeNames: { NATIONAL_ID: 'Renombrado' },
      }).expect(200);
      const again = await get<{
        patientDocument: string;
        integrityOk: boolean;
      }>(`/prescriptions/${inB.id}`, dentist);
      expect(again).toMatchObject({
        patientDocument: 'Documento B S-524',
        integrityOk: true,
      });
      await patchLocation(locB, {
        docTypeNames: { NATIONAL_ID: 'Documento B' },
      }).expect(200);
    });

    it('a receipt freezes the name of the payment location, whichever location is active when it is read', async () => {
      const planId = (
        await post<{ id: string }>(
          `/patients/${patientId}/treatment-plans`,
          { currency: 'USD' },
          adminA,
          locB,
        )
      ).id;
      await post(
        `/treatment-plans/${planId}/items`,
        { toothNumber: '36', catalogItemId, price: 100 },
        adminA,
        locB,
      );
      const payment = await post<{ id: string }>(
        `/treatment-plans/${planId}/payments`,
        {
          amount: 10,
          currency: 'USD',
          paidAt: new Date().toISOString(),
          method: 'CARD',
        },
        adminA,
        locB,
      );
      const receipt = (location?: string) =>
        get<{ snapshot: { patient: { docTypeName: string } } }>(
          `/payments/${payment.id}/receipt`,
          adminA,
          location,
        );
      expect((await receipt(locB)).snapshot.patient.docTypeName).toBe(
        'Documento B',
      );
      expect((await receipt(locC)).snapshot.patient.docTypeName).toBe(
        'Documento B',
      );
    });
  });
});
