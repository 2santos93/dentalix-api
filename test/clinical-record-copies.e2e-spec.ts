import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  type Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationBody,
} from './support/location-fixtures';
import { LOCATION_NOT_ALLOWED_CODE } from '../src/shared/tenancy/location-access';

// DX-456 en HTTP real: «Copia de la historia clínica». Roles (recepción 403),
// sede no permitida (403), otra clínica (404), el documento con lo del período
// (evoluciones con adendas en orden, anuladas fuera), el evento EXPORT sin
// datos clínicos ni «entregado a», un período vacío y el listado de la ficha.
// DIRECT_URL (superusuario, sin RLS) siembra la historia y lee la auditoría.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const NOTE = 'Exodoncia del 38 sin complicaciones (DX456-NOTA)';
const ADDENDUM_1 = 'Se indica control a los 7 días (DX456-ADENDA-1)';
const ADDENDUM_2 = 'El paciente refiere evolución favorable (DX456-ADENDA-2)';
const VOIDED_NOTE = 'Evolución anulada (DX456-ANULADA)';
const DELIVERED_TO = 'Carmen Rondón (madre)';

interface Summary {
  id: string;
  from: string;
  to: string;
  sections: string[];
  deliveredTo: string | null;
  generatedAt: string;
  generatedBy: { id: string; name: string | null };
  location: { id: string; name: string };
}

interface CopyDocument {
  copy: Summary;
  clinic: { name: string };
  location: { name: string; timeZone: string };
  patient: { name: string; patientCode: number; document: string | null };
  content: Record<string, unknown[] | undefined>;
  empty: boolean;
}

interface ErrorBody {
  message: string;
  code?: string;
}

describe('Copia de la historia clínica (e2e, DX-456)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let locationA: string;
  let otherLocation: string;
  let patientId: string;
  let dentistUserId: string;
  let dentistToken: string;
  let receptionToken: string;
  let assistantEmail: string;
  let assistantUserId: string;
  let copyId: string;

  const server = () => request(app.getHttpServer());
  const as = (
    clinic: Clinic,
    token = clinic.adminToken,
    locationId?: string,
  ) => {
    const set = (req: request.Test) => {
      const r = req
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`);
      return locationId ? r.set('X-Location-Id', locationId) : r;
    };
    return {
      get: (path: string) => set(server().get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) =>
        set(server().post(`/api/v1${path}`)).send(body),
      put: (path: string, body: object = {}) =>
        set(server().put(`/api/v1${path}`)).send(body),
    };
  };

  const copies = (patient = patientId) =>
    `/patients/${patient}/clinical-record-copies`;

  const generate = (
    body: object,
    token = dentistToken,
    clinic = clinicA,
    patient = patientId,
    locationId?: string,
  ) => as(clinic, token, locationId).post(copies(patient), body);

  const ALL_SECTIONS = [
    'EVOLUTIONS',
    'DIAGNOSES',
    'ANAMNESIS',
    'ODONTOGRAM',
    'ANESTHESIA_SEDATION',
    'CONSENTS',
    'PRESCRIPTIONS',
    'APPOINTMENTS',
  ];

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp();
    clinicA = await registerClinic(app, 'dx456-copy-a');
    clinicB = await registerClinic(app, 'dx456-copy-b');
    locationA = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinicA.tenantId },
        orderBy: { createdAt: 'asc' },
      })
    ).id;
    otherLocation = (
      (
        await as(clinicA)
          .post(
            '/locations',
            locationBody(REGIONAL_CARACAS_FIXTURE, { name: 'Sede Valencia' }),
          )
          .expect(201)
      ).body as { id: string }
    ).id;
    const created = await as(clinicA)
      .post('/patients', {
        docType: 'NATIONAL_ID',
        docNumber: 'V-12345678',
        sex: 'F',
        firstName: 'Mariela',
        lastName: 'Rondón',
        birthDate: '1985-06-20',
        phone: '+58 412 1234567',
      })
      .expect(201);
    patientId = (created.body as { id: string }).id;

    const dentist = await seedMember(raw, clinicA, ClinicRole.DENTIST);
    dentistUserId = dentist.userId;
    await raw.clinicMembership.updateMany({
      where: { tenantId: clinicA.tenantId, userId: dentist.userId },
      data: { professionalLicense: 'MPPS 45678' },
    });
    dentistToken = await loginAs(app, clinicA.host, dentist.email);
    const reception = await seedMember(raw, clinicA, ClinicRole.RECEPTION);
    receptionToken = await loginAs(app, clinicA.host, reception.email);
    const assistant = await seedMember(raw, clinicA, ClinicRole.ASSISTANT);
    assistantEmail = assistant.email;
    assistantUserId = assistant.userId;

    // Historia del paciente en marzo de 2026 (Caracas, UTC−4).
    const entry = await raw.clinicalEntry.create({
      data: {
        tenantId: clinicA.tenantId,
        patientId,
        locationId: locationA,
        entryDate: new Date('2026-03-10T14:00:00Z'),
        reason: 'Dolor en el 38',
        notes: NOTE,
        performedById: dentistUserId,
        authorProfessionalLicense: 'MPPS 45678',
      },
    });
    for (const [text, at] of [
      [ADDENDUM_1, '2026-03-10T16:00:00Z'],
      [ADDENDUM_2, '2026-03-17T15:00:00Z'],
    ]) {
      await raw.clinicalEntryAddendum.create({
        data: {
          tenantId: clinicA.tenantId,
          patientId,
          clinicalEntryId: entry.id,
          reason: 'Seguimiento',
          text,
          authorId: dentistUserId,
          createdAt: new Date(at),
        },
      });
    }
    await raw.clinicalEntry.create({
      data: {
        tenantId: clinicA.tenantId,
        patientId,
        locationId: locationA,
        entryDate: new Date('2026-03-12T14:00:00Z'),
        notes: VOIDED_NOTE,
        performedById: dentistUserId,
        deletedAt: new Date('2026-03-12T15:00:00Z'),
      },
    });
    // Fuera del período: el 1 de abril a las 00:30 en Caracas.
    await raw.clinicalEntry.create({
      data: {
        tenantId: clinicA.tenantId,
        patientId,
        locationId: locationA,
        entryDate: new Date('2026-04-01T04:30:00Z'),
        notes: 'Fuera del período (DX456-FUERA)',
        performedById: dentistUserId,
      },
    });
    await raw.appointment.create({
      data: {
        tenantId: clinicA.tenantId,
        locationId: locationA,
        patientId,
        providerId: dentistUserId,
        start: new Date('2026-03-10T13:30:00Z'),
        end: new Date('2026-03-10T14:30:00Z'),
        status: 'COMPLETED',
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('el odontólogo genera la copia: resumen sin contenido clínico y un evento EXPORT sin datos clínicos ni «entregado a»', async () => {
    const res = await generate({
      from: '2026-03-01',
      to: '2026-03-31',
      sections: ['APPOINTMENTS', 'EVOLUTIONS', 'DIAGNOSES'],
      deliveredTo: `  ${DELIVERED_TO} `,
    }).expect(201);
    const summary = res.body as Summary;
    copyId = summary.id;
    expect(summary).toMatchObject({
      from: '2026-03-01',
      to: '2026-03-31',
      sections: ['EVOLUTIONS', 'DIAGNOSES', 'APPOINTMENTS'],
      deliveredTo: DELIVERED_TO,
      generatedBy: { id: dentistUserId, name: 'Miembro DENTIST' },
      location: { id: locationA },
    });
    expect(JSON.stringify(summary)).not.toContain('DX456');

    const events = await raw.auditEvent.findMany({
      where: { tenantId: clinicA.tenantId, patientId, action: 'EXPORT' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: dentistUserId,
      actorRole: 'DENTIST',
      resourceType: 'PATIENT',
      resourceId: patientId,
      metadata: {
        reason: 'CLINICAL_RECORD_COPY_GENERATED',
        params: { patientId, copyId },
        period: { from: '2026-03-01', to: '2026-03-31' },
        recordCopy: {
          sections: ['EVOLUTIONS', 'DIAGNOSES', 'APPOINTMENTS'],
          deliveredTo: true,
        },
      },
    });
    const metadata = JSON.stringify(events[0].metadata);
    expect(metadata).not.toMatch(/DX456|Carmen|Exodoncia|Dolor/);
  });

  it('el documento trae la cabecera y lo del período: evoluciones con adendas en orden, anuladas fuera, sin ids internos', async () => {
    const res = await as(clinicA, dentistToken)
      .get(`${copies()}/${copyId}/document`)
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const doc = res.body as CopyDocument;
    expect(doc).toMatchObject({
      clinic: { name: 'Clinica dx456-copy-a' },
      location: { timeZone: 'America/Caracas' },
      patient: { name: 'Mariela Rondón' },
      empty: false,
    });
    expect(doc.patient.document).toContain('V-12345678');
    expect(Object.keys(doc.content).sort()).toEqual([
      'appointments',
      'diagnoses',
      'evolutions',
    ]);
    const evolutions = doc.content.evolutions as {
      notes: string;
      locationName: string | null;
      addenda: { text: string }[];
    }[];
    expect(evolutions).toHaveLength(1);
    expect(evolutions[0]).toMatchObject({
      notes: NOTE,
      reason: 'Dolor en el 38',
      authorName: 'Miembro DENTIST',
      authorLicense: 'MPPS 45678',
    });
    expect(evolutions[0].locationName).not.toBeNull();
    expect(evolutions[0].addenda.map((a) => a.text)).toEqual([
      ADDENDUM_1,
      ADDENDUM_2,
    ]);
    expect(doc.content.appointments).toEqual([
      expect.objectContaining({
        status: 'COMPLETED',
        providerName: 'Miembro DENTIST',
      }),
    ]);
    const body = JSON.stringify(doc.content);
    expect(body).not.toContain('DX456-ANULADA');
    expect(body).not.toContain('DX456-FUERA');
    expect(body).not.toContain(patientId);
    expect(body).not.toContain(dentistUserId);
    expect(body).not.toMatch(/"id":/);

    const printed = await raw.auditEvent.findMany({
      where: { tenantId: clinicA.tenantId, patientId, action: 'PRINT' },
    });
    expect(printed).toHaveLength(1);
    expect(printed[0].metadata).toMatchObject({
      reason: 'CLINICAL_RECORD_COPY_PRINTED',
      params: { patientId, copyId },
    });
  });

  it('la ficha lista las generaciones anteriores, la más reciente primero', async () => {
    await generate({
      from: '2026-01-01',
      to: '2026-01-31',
      sections: ['CONSENTS'],
    }).expect(201);
    const list = (await as(clinicA, dentistToken).get(copies()).expect(200))
      .body as Summary[];
    expect(list.map((c) => c.from)).toEqual(['2026-01-01', '2026-03-01']);
    expect(list[1]).toMatchObject({ id: copyId, deliveredTo: DELIVERED_TO });
  });

  it('un período sin registros: el documento sale vacío («Sin registros en el período»)', async () => {
    const empty = (
      await generate({
        from: '2025-06-01',
        to: '2025-06-30',
        sections: ALL_SECTIONS,
      }).expect(201)
    ).body as Summary;
    const doc = (
      await as(clinicA, dentistToken)
        .get(`${copies()}/${empty.id}/document`)
        .expect(200)
    ).body as CopyDocument;
    expect(doc.empty).toBe(true);
    expect(doc.content).toEqual({
      evolutions: [],
      diagnoses: [],
      anamnesis: [],
      odontogram: [],
      anesthesia: [],
      sedation: [],
      consents: [],
      prescriptions: [],
      appointments: [],
    });
  });

  it.each([
    ['período al revés', { from: '2026-03-31', to: '2026-03-01' }],
    ['empieza después de hoy', { from: '2099-01-01', to: '2099-01-31' }],
    ['sin secciones', { sections: [] }],
    ['sección desconocida', { sections: ['NOTES'] }],
    ['«entregado a» en varias líneas', { deliveredTo: 'Ana\nPérez' }],
  ])('400: %s, sin generación ni evento', async (_label, patch) => {
    const before = await raw.clinicalRecordCopy.count({
      where: { tenantId: clinicA.tenantId },
    });
    await generate({
      from: '2026-03-01',
      to: '2026-03-31',
      sections: ['EVOLUTIONS'],
      ...patch,
    }).expect(400);
    await expect(
      raw.clinicalRecordCopy.count({ where: { tenantId: clinicA.tenantId } }),
    ).resolves.toBe(before);
  });

  it('recepción no genera, no lista ni lee la copia (403)', async () => {
    const denied = await generate(
      { from: '2026-03-01', to: '2026-03-31', sections: ['EVOLUTIONS'] },
      receptionToken,
    ).expect(403);
    expect((denied.body as ErrorBody).message).toMatch(/personal clínico/);
    await as(clinicA, receptionToken).get(copies()).expect(403);
    await as(clinicA, receptionToken)
      .get(`${copies()}/${copyId}/document`)
      .expect(403);
  });

  it('la asistente genera la copia en su sede; en una sede no permitida, 403 LOCATION_NOT_ALLOWED', async () => {
    // Restringida a la sede principal (token nuevo con el claim `loc`).
    await as(clinicA)
      .put(`/staff/${assistantUserId}/locations`, { locationIds: [locationA] })
      .expect(200);
    const token = await loginAs(app, clinicA.host, assistantEmail);
    const body = {
      from: '2026-03-01',
      to: '2026-03-31',
      sections: ['EVOLUTIONS'],
    };
    const own = (
      await generate(body, token, clinicA, patientId, locationA).expect(201)
    ).body as Summary;
    expect(own.location.id).toBe(locationA);

    const denied = await generate(
      body,
      token,
      clinicA,
      patientId,
      otherLocation,
    ).expect(403);
    expect((denied.body as ErrorBody).code).toBe(LOCATION_NOT_ALLOWED_CODE);

    // Una copia generada en la otra sede (por el ADMIN) no se le imprime.
    const foreign = (
      await generate(
        body,
        clinicA.adminToken,
        clinicA,
        patientId,
        otherLocation,
      ).expect(201)
    ).body as Summary;
    const read = await as(clinicA, token)
      .get(`${copies()}/${foreign.id}/document`)
      .expect(403);
    expect((read.body as ErrorBody).code).toBe(LOCATION_NOT_ALLOWED_CODE);
  });

  describe('otra clínica (B) no llega al paciente ni a sus copias (404)', () => {
    // ISOLATION_COVERS: POST /patients/:patientId/clinical-record-copies
    it('B no genera una copia del paciente de A, ni queda generación o evento', async () => {
      const before = await raw.clinicalRecordCopy.count();
      await generate(
        { from: '2026-03-01', to: '2026-03-31', sections: ['EVOLUTIONS'] },
        clinicB.adminToken,
        clinicB,
      ).expect(404);
      await expect(raw.clinicalRecordCopy.count()).resolves.toBe(before);
      await expect(
        raw.auditEvent.count({
          where: { tenantId: clinicB.tenantId, action: 'EXPORT' },
        }),
      ).resolves.toBe(0);
    });

    // ISOLATION_COVERS: GET /patients/:patientId/clinical-record-copies
    it('B no lista las copias del paciente de A', async () => {
      await as(clinicB).get(copies()).expect(404);
    });

    // ISOLATION_COVERS: GET /patients/:patientId/clinical-record-copies/:copyId/document
    it('B no lee el documento de una copia de A', async () => {
      await as(clinicB).get(`${copies()}/${copyId}/document`).expect(404);
    });
  });
});
