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

// DX-306 en HTTP real: justificante de asistencia y certificado de reposo.
// Roles (recepción emite el justificante; el reposo solo DENTIST/ADMIN con
// registro), cita atendida (409), sede no permitida (403), aislamiento entre
// dos clínicas (404), PDF archivado en la ficha (REPORT), anulación con
// motivo (y «ANULADO» archivado) y auditoría sin diagnóstico. DIRECT_URL
// (superusuario, sin RLS) siembra las citas atendidas y lee lo guardado.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DIAGNOSIS = 'Alveolitis tras exodoncia del 38';

interface Certificate {
  id: string;
  kind: 'ATTENDANCE' | 'REST';
  number: number;
  numberLabel: string;
  timesSource: 'ACTUAL' | 'SCHEDULED';
  attendedFrom: string;
  attendedUntil: string;
  restDays: number | null;
  restStartDate: string | null;
  restEndDate: string | null;
  diagnosis: string | null;
  hasDiagnosis: boolean;
  documentId: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  voidedDocumentId: string | null;
  snapshot: {
    patient: { name: string; document: string | null };
    professional: { name: string; license: string | null };
    location: { name: string; timeZone: string; locale: string };
  };
}

interface ErrorBody {
  message: string;
  code?: string;
}

describe('Certificados del paciente (e2e, DX-306)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let locationA: string;
  let patientId: string;
  let receptionToken: string;
  let dentistToken: string;
  let assistantToken: string;
  let dentistUserId: string;
  let assistantUserId: string;
  let assistantEmail: string;
  let slot = 0;

  const server = () => request(app.getHttpServer());
  const as = (clinic: Clinic, token = clinic.adminToken) => {
    const set = (req: request.Test) =>
      req
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`);
    return {
      get: (path: string) => set(server().get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) =>
        set(server().post(`/api/v1${path}`)).send(body),
      put: (path: string, body: object = {}) =>
        set(server().put(`/api/v1${path}`)).send(body),
    };
  };

  /** Cita sembrada y cerrada como la app (UPDATE a COMPLETED: el trigger fija la salida). */
  const appointment = async (
    opts: {
      status?: 'COMPLETED' | 'SCHEDULED';
      arrived?: boolean;
      locationId?: string;
      clinic?: Clinic;
      patient?: string;
    } = {},
  ): Promise<string> => {
    slot += 1;
    const clinic = opts.clinic ?? clinicA;
    // Pasado, hora a hora: sin solapes del profesional ni del paciente.
    const start = new Date(Date.UTC(2026, 9, 1, 12, 0) + slot * 3_600_000);
    const created = await raw.appointment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId: opts.locationId ?? locationA,
        patientId: opts.patient ?? patientId,
        providerId: dentistUserId,
        start,
        end: new Date(start.getTime() + 30 * 60_000),
      },
    });
    if (opts.arrived) {
      await raw.appointment.update({
        where: { id: created.id },
        data: {
          status: 'ARRIVED',
          preArrivalStatus: 'SCHEDULED',
          arrivedAt: new Date(start.getTime() - 5 * 60_000),
        },
      });
      await raw.appointment.update({
        where: { id: created.id },
        data: { status: 'SCHEDULED', preArrivalStatus: null },
      });
    }
    if ((opts.status ?? 'COMPLETED') === 'COMPLETED') {
      await raw.appointment.update({
        where: { id: created.id },
        data: { status: 'COMPLETED' },
      });
    }
    return created.id;
  };

  const issue = (
    body: object,
    token = receptionToken,
    clinic = clinicA,
    patient = patientId,
  ) => as(clinic, token).post(`/patients/${patient}/certificates`, body);

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp();
    clinicA = await registerClinic(app, 'dx306-cert-a');
    clinicB = await registerClinic(app, 'dx306-cert-b');
    locationA = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinicA.tenantId },
        orderBy: { createdAt: 'asc' },
      })
    ).id;
    const created = await as(clinicA)
      .post('/patients', {
        docType: 'NATIONAL_ID',
        docNumber: 'V-12345678',
        sex: 'F',
        firstName: 'Mariela',
        lastName: 'Rondón',
        birthDate: '1985-06-20',
      })
      .expect(201);
    patientId = (created.body as { id: string }).id;

    const reception = await seedMember(raw, clinicA, ClinicRole.RECEPTION);
    receptionToken = await loginAs(app, clinicA.host, reception.email);
    const dentist = await seedMember(raw, clinicA, ClinicRole.DENTIST);
    dentistUserId = dentist.userId;
    await raw.clinicMembership.updateMany({
      where: { tenantId: clinicA.tenantId, userId: dentist.userId },
      data: { professionalLicense: 'MPPS 45678' },
    });
    dentistToken = await loginAs(app, clinicA.host, dentist.email);
    const assistant = await seedMember(raw, clinicA, ClinicRole.ASSISTANT);
    assistantToken = await loginAs(app, clinicA.host, assistant.email);
    assistantUserId = assistant.userId;
    assistantEmail = assistant.email;
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('recepción emite el justificante de una cita atendida con las horas reales, la foto y el PDF archivado (REPORT)', async () => {
    const apptId = await appointment({ arrived: true });
    const res = await issue({
      kind: 'ATTENDANCE',
      appointmentId: apptId,
    }).expect(201);
    const cert = res.body as Certificate;
    expect(cert).toMatchObject({
      kind: 'ATTENDANCE',
      number: 1,
      numberLabel: '000001',
      timesSource: 'ACTUAL',
      diagnosis: null,
      hasDiagnosis: false,
      restDays: null,
    });
    expect(cert.snapshot.patient.name).toBe('Mariela Rondón');
    expect(cert.snapshot.patient.document).toContain('V-12345678');
    expect(cert.snapshot.professional.name).toBe('Miembro DENTIST');
    expect(cert.snapshot.location.timeZone).toBe('America/Caracas');
    const appt = await raw.appointment.findUniqueOrThrow({
      where: { id: apptId },
    });
    expect(cert.attendedFrom).toBe(appt.arrivedAt!.toISOString());
    expect(cert.attendedUntil).toBe(appt.completedAt!.toISOString());

    const docs = await as(clinicA, receptionToken)
      .get(`/patients/${patientId}/documents`)
      .expect(200);
    expect(JSON.stringify(docs.body)).toContain(cert.documentId!);
    const doc = await raw.patientDocument.findUniqueOrThrow({
      where: { id: cert.documentId! },
    });
    expect(doc).toMatchObject({
      category: 'REPORT',
      mimeType: 'application/pdf',
      originalName: 'justificante-000001.pdf',
    });

    const pdf = await as(clinicA, receptionToken)
      .get(`/patients/${patientId}/certificates/${cert.id}/pdf`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['cache-control']).toBe('private, no-store');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');

    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinicA.tenantId,
        resourceType: 'PATIENT_CERTIFICATE',
      },
    });
    expect(events.map((e) => e.action).sort()).toEqual(['CREATE', 'PRINT']);
    const created = events.find((e) => e.action === 'CREATE')!;
    expect(created).toMatchObject({ resourceId: cert.id, patientId });
    expect(created.metadata).toMatchObject({ reason: 'CERTIFICATE_ISSUED' });
  });

  it('sin llegada registrada: horas programadas; segundo justificante de la misma cita: 409 con el número', async () => {
    const apptId = await appointment();
    const cert = (
      await issue({ kind: 'ATTENDANCE', appointmentId: apptId }).expect(201)
    ).body as Certificate;
    expect(cert.timesSource).toBe('SCHEDULED');
    const again = await issue({
      kind: 'ATTENDANCE',
      appointmentId: apptId,
    }).expect(409);
    expect((again.body as ErrorBody).message).toBe(
      `Ya hay un justificante de asistencia vigente de esta cita (Nº ${cert.numberLabel}). Anúlalo para emitir otro.`,
    );
  });

  it('cita no atendida: 409 en español; cita de otro paciente: 404', async () => {
    const apptId = await appointment({ status: 'SCHEDULED' });
    const res = await issue({
      kind: 'ATTENDANCE',
      appointmentId: apptId,
    }).expect(409);
    expect((res.body as ErrorBody).message).toBe(
      'Solo se emite para una cita atendida: esta cita está agendada.',
    );
    const other = await raw.patient.create({
      data: {
        tenantId: clinicA.tenantId,
        firstName: 'Luis',
        lastName: 'Gómez',
      },
    });
    const otherAppt = await appointment({ patient: other.id });
    await issue({ kind: 'ATTENDANCE', appointmentId: otherAppt }).expect(404);
  });

  it('sede no permitida: 403 LOCATION_NOT_ALLOWED al emitir, imprimir y anular', async () => {
    const otherLocation = (
      (
        await as(clinicA)
          .post(
            '/locations',
            locationBody(REGIONAL_CARACAS_FIXTURE, { name: 'Sede Valencia' }),
          )
          .expect(201)
      ).body as { id: string }
    ).id;
    const apptId = await appointment({ locationId: otherLocation });
    // La asistente queda restringida a la sede principal (token nuevo con
    // el claim `loc`).
    await as(clinicA)
      .put(`/staff/${assistantUserId}/locations`, { locationIds: [locationA] })
      .expect(200);
    const token = await loginAs(app, clinicA.host, assistantEmail);
    const denied = await issue(
      { kind: 'ATTENDANCE', appointmentId: apptId },
      token,
    ).expect(403);
    expect((denied.body as ErrorBody).code).toBe(LOCATION_NOT_ALLOWED_CODE);

    const cert = (
      await issue(
        { kind: 'ATTENDANCE', appointmentId: apptId },
        clinicA.adminToken,
      ).expect(201)
    ).body as Certificate;
    await as(clinicA, token)
      .get(`/patients/${patientId}/certificates/${cert.id}/pdf`)
      .expect(403);
    await as(clinicA, token)
      .post(`/patients/${patientId}/certificates/${cert.id}/void`, {
        reason: 'Sede equivocada',
      })
      .expect(403);
    // Las citas de la otra sede no salen en su selector.
    const eligible = await as(clinicA, token)
      .get(`/patients/${patientId}/certificates/appointments`)
      .expect(200);
    expect((eligible.body as { id: string }[]).map((a) => a.id)).not.toContain(
      apptId,
    );
  });

  describe('reposo', () => {
    it('recepción y asistente: 403; ADMIN sin registro profesional: 400 que dice qué', async () => {
      const apptId = await appointment();
      const body = { kind: 'REST', appointmentId: apptId, restDays: 2 };
      await issue(body, receptionToken).expect(403);
      await issue(body, assistantToken).expect(403);
      const res = await issue(
        { ...body, restDays: 45 },
        clinicA.adminToken,
      ).expect(400);
      expect((res.body as ErrorBody).message).toBe(
        'No se puede emitir el certificado de reposo: falta tu número de registro profesional (lo añade un administrador en Personal); los días de reposo deben ser un número entero entre 1 y 30.',
      );
    });

    it('DENTIST con registro: días y fechas; el diagnóstico solo si la clínica lo imprime; recepción no lo ve ni lo imprime', async () => {
      const apptId = await appointment();
      const noPrint = await issue(
        {
          kind: 'REST',
          appointmentId: apptId,
          restDays: 3,
          diagnosis: DIAGNOSIS,
        },
        dentistToken,
      ).expect(400);
      expect((noPrint.body as ErrorBody).message).toContain(
        'la clínica no imprime el diagnóstico',
      );

      await as(clinicA, receptionToken)
        .put('/certificates/settings', {
          restMaxDays: 15,
          restPrintDiagnosis: true,
        })
        .expect(403);
      await as(clinicA)
        .put('/certificates/settings', {
          restMaxDays: 15,
          restPrintDiagnosis: true,
        })
        .expect(200);
      await expect(
        as(clinicA, receptionToken).get('/certificates/settings'),
      ).resolves.toMatchObject({
        body: { restMaxDays: 15, restPrintDiagnosis: true },
      });

      const tooMany = await issue(
        { kind: 'REST', appointmentId: apptId, restDays: 16 },
        dentistToken,
      ).expect(400);
      expect((tooMany.body as ErrorBody).message).toContain('entre 1 y 15');
      const early = await issue(
        {
          kind: 'REST',
          appointmentId: apptId,
          restDays: 2,
          restStartDate: '2026-09-01',
        },
        dentistToken,
      ).expect(400);
      expect((early.body as ErrorBody).message).toContain(
        'no puede empezar antes del día de la atención',
      );

      const cert = (
        await issue(
          {
            kind: 'REST',
            appointmentId: apptId,
            restDays: 3,
            diagnosis: DIAGNOSIS,
          },
          dentistToken,
        ).expect(201)
      ).body as Certificate;
      expect(cert).toMatchObject({
        kind: 'REST',
        restDays: 3,
        diagnosis: DIAGNOSIS,
        hasDiagnosis: true,
      });
      expect(cert.snapshot.professional.license).toBe('MPPS 45678');

      const seen = (
        await as(clinicA, receptionToken)
          .get(`/patients/${patientId}/certificates`)
          .expect(200)
      ).body as Certificate[];
      const forReception = seen.find((c) => c.id === cert.id)!;
      expect(forReception).toMatchObject({
        diagnosis: null,
        hasDiagnosis: true,
      });
      await as(clinicA, receptionToken)
        .get(`/patients/${patientId}/certificates/${cert.id}/pdf`)
        .expect(403);
      await as(clinicA, assistantToken)
        .get(`/patients/${patientId}/certificates/${cert.id}/pdf`)
        .expect(200);

      // El diagnóstico nunca va a la auditoría.
      const events = await raw.auditEvent.findMany({
        where: { tenantId: clinicA.tenantId, resourceId: cert.id },
      });
      expect(events.length).toBeGreaterThan(0);
      expect(JSON.stringify(events)).not.toContain('Alveolitis');
      const settingsEvent = await raw.auditEvent.findFirst({
        where: {
          tenantId: clinicA.tenantId,
          resourceType: 'CLINIC_SETTINGS',
          metadata: { path: ['reason'], equals: 'CERTIFICATE_SETTINGS' },
        },
      });
      expect(settingsEvent?.metadata).toMatchObject({
        changedFields: ['restMaxDays', 'restPrintDiagnosis'],
      });
    });
  });

  it('anular: motivo obligatorio, solo quien emitió o ADMIN, una vez; el PDF dice ANULADO y queda archivado', async () => {
    const apptId = await appointment();
    const cert = (
      await issue({ kind: 'ATTENDANCE', appointmentId: apptId }).expect(201)
    ).body as Certificate;
    const voidPath = `/patients/${patientId}/certificates/${cert.id}/void`;
    await as(clinicA, receptionToken)
      .post(voidPath, { reason: 'a' })
      .expect(400);
    await as(clinicA, dentistToken)
      .post(voidPath, { reason: 'No lo emití' })
      .expect(403);
    const voided = (
      await as(clinicA, receptionToken)
        .post(voidPath, { reason: 'Fecha equivocada' })
        .expect(200)
    ).body as Certificate;
    expect(voided).toMatchObject({ voidReason: 'Fecha equivocada' });
    expect(voided.voidedAt).not.toBeNull();
    expect(voided.voidedDocumentId).not.toBeNull();
    await as(clinicA).post(voidPath, { reason: 'Otra vez' }).expect(409);

    const original = await raw.patientDocument.findUniqueOrThrow({
      where: { id: cert.documentId! },
    });
    expect(original.voidReason).toBe('Certificado anulado: Fecha equivocada');
    const annulled = await raw.patientDocument.findUniqueOrThrow({
      where: { id: voided.voidedDocumentId! },
    });
    expect(annulled.originalName).toBe(
      `justificante-${cert.numberLabel}-anulado.pdf`,
    );
    const event = await raw.auditEvent.findFirst({
      where: { resourceId: cert.id, action: 'VOID' },
    });
    expect(event?.metadata).toMatchObject({ reason: 'CERTIFICATE_VOIDED' });
    expect(JSON.stringify(event?.metadata)).not.toContain('Fecha equivocada');

    // Anulado, se puede emitir otro de la misma cita.
    await issue({ kind: 'ATTENDANCE', appointmentId: apptId }).expect(201);
  });

  it('el número es correlativo por sede', async () => {
    const certs = (
      await as(clinicA, receptionToken)
        .get(`/patients/${patientId}/certificates`)
        .expect(200)
    ).body as (Certificate & { locationId: string })[];
    const here = certs
      .filter((c) => c.locationId === locationA)
      .map((c) => c.number)
      .sort((x, y) => x - y);
    expect(here).toEqual(Array.from({ length: here.length }, (_, i) => i + 1));
  });

  describe('aislamiento entre clínicas', () => {
    let certId: string;
    let apptId: string;

    beforeAll(async () => {
      apptId = await appointment();
      certId = (
        (await issue({ kind: 'ATTENDANCE', appointmentId: apptId }).expect(201))
          .body as Certificate
      ).id;
    });

    // ISOLATION_COVERS: GET /patients/:patientId/certificates
    it('B no lista los certificados del paciente de A', async () => {
      await as(clinicB).get(`/patients/${patientId}/certificates`).expect(404);
    });

    // ISOLATION_COVERS: GET /patients/:patientId/certificates/appointments
    it('B no ve las citas atendidas del paciente de A', async () => {
      await as(clinicB)
        .get(`/patients/${patientId}/certificates/appointments`)
        .expect(404);
    });

    // ISOLATION_COVERS: POST /patients/:patientId/certificates
    it('B no emite sobre el paciente ni la cita de A', async () => {
      await issue(
        { kind: 'ATTENDANCE', appointmentId: apptId },
        clinicB.adminToken,
        clinicB,
      ).expect(404);
      const ownPatient = (
        (
          await as(clinicB)
            .post('/patients', {
              docType: 'NATIONAL_ID',
              docNumber: 'V-87654321',
              sex: 'M',
              firstName: 'Pedro',
              lastName: 'Lugo',
            })
            .expect(201)
        ).body as { id: string }
      ).id;
      await issue(
        { kind: 'ATTENDANCE', appointmentId: apptId },
        clinicB.adminToken,
        clinicB,
        ownPatient,
      ).expect(404);
      expect(
        await raw.patientCertificate.count({
          where: { tenantId: clinicB.tenantId },
        }),
      ).toBe(0);
    });

    // ISOLATION_COVERS: GET /patients/:patientId/certificates/:id/pdf
    it('B no imprime el certificado de A', async () => {
      await as(clinicB)
        .get(`/patients/${patientId}/certificates/${certId}/pdf`)
        .expect(404);
    });

    // ISOLATION_COVERS: POST /patients/:patientId/certificates/:id/void
    it('B no anula el certificado de A y sigue vigente', async () => {
      await as(clinicB)
        .post(`/patients/${patientId}/certificates/${certId}/void`, {
          reason: 'Intrusa',
        })
        .expect(404);
      const row = await raw.patientCertificate.findUniqueOrThrow({
        where: { id: certId },
      });
      expect(row.voidedAt).toBeNull();
    });
  });

  it('issuer: qué puede emitir cada rol', async () => {
    await expect(
      as(clinicA, receptionToken).get('/certificates/issuer'),
    ).resolves.toMatchObject({
      body: {
        canIssueAttendance: true,
        canIssueRest: false,
        professionalLicense: null,
      },
    });
    await expect(
      as(clinicA, dentistToken).get('/certificates/issuer'),
    ).resolves.toMatchObject({
      body: {
        canIssueAttendance: true,
        canIssueRest: true,
        professionalLicense: 'MPPS 45678',
      },
    });
  });
});
