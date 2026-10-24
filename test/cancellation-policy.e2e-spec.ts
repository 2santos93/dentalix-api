import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ClinicRole, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  CANCELLATION_MESSAGES,
  CANCELLATION_POLICY_MESSAGES,
} from '../src/modules/cancellation-policies/domain/cancellation-policy';

// DX-279 (porción 1): política de cancelación por sede (solo ADMIN, versiones
// append-only), cancelar desde la agenda con origen y motivo (el servidor
// calcula el aviso y si es tardía), el enlace público del paciente y el
// resumen de asistencia de 12 meses (con la restricción por sedes, DX-089).

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const HOUR = 3_600_000;

interface PolicyVersion {
  id: string;
  version: number;
  noticeHours: number;
  suggestedFee: number | null;
  currency: string | null;
  patientText: string;
}

interface AppointmentBody {
  id: string;
  patientId: string;
  status: string;
  cancelledAt: string | null;
  cancelledByKind: string | null;
  cancelReasonCode: string | null;
  cancelReasonText?: string | null;
  noticeMinutes: number | null;
  lateCancellation: boolean | null;
  noShowMarkedAt: string | null;
  policyVersionId: string | null;
  attendance?: { noShows: number; lateCancellations: number };
}

describe('Política de cancelación por sede y cancelaciones (DX-279)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let principal: string;
  let norte: string;
  let patient: string;
  let otherPatient: string;
  const tokens: Partial<Record<ClinicRole, string>> = {};
  let norteReception: string;

  function api(clinic: Clinic, token: string, locationId?: string) {
    const server = app.getHttpServer();
    const auth = (t: request.Test) => {
      const withAuth = t
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`);
      return locationId ? withAuth.set('X-Location-Id', locationId) : withAuth;
    };
    return {
      get: (path: string, query: object = {}) =>
        auth(request(server).get(`/api/v1${path}`)).query(query),
      post: (path: string, body: object = {}) =>
        auth(request(server).post(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) =>
        auth(request(server).patch(`/api/v1${path}`)).send(body),
      put: (path: string, body: object) =>
        auth(request(server).put(`/api/v1${path}`)).send(body),
    };
  }
  const admin = () => api(a, a.adminToken);

  const starts = new Map<string, Date>();
  /** Minutos que faltan hoy para el inicio de la cita (con un margen de 1). */
  const expectNotice = (id: string, minutes: number | null) => {
    const expected = Math.floor(
      (starts.get(id)!.getTime() - Date.now()) / 60_000,
    );
    expect(minutes).not.toBeNull();
    expect(Math.abs(minutes! - expected)).toBeLessThanOrEqual(1);
  };
  /** Una cita de A (sembrada por `raw`: el horario no importa aquí). */
  async function appointment(
    hoursFromNow: number,
    locationId = principal,
    patientId = patient,
  ): Promise<string> {
    // Un profesional por cita (sin solapes del profesional); las del mismo
    // paciente van a horas distintas.
    const start = new Date(Date.now() + hoursFromNow * HOUR);
    const created = await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId,
        patientId,
        providerId: randomUUID(),
        start,
        end: new Date(start.getTime() + 30 * 60_000),
      },
    });
    starts.set(created.id, start);
    return created.id;
  }

  const cancel = (id: string, body: object, token = tokens.RECEPTION!) =>
    api(a, token).patch(`/appointments/${id}`, {
      status: 'CANCELLED',
      ...body,
    });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx279-a');
    b = await registerClinic(app, 'dx279-b');
    principal = (
      (await admin().get('/locations').expect(200)).body as { id: string }[]
    )[0].id;
    norte = (
      (await admin().post('/locations', { name: 'Sede Norte' }).expect(201))
        .body as { id: string }
    ).id;
    for (const role of [
      ClinicRole.RECEPTION,
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
    ]) {
      const m = await seedMember(raw, a, role);
      tokens[role] = await loginAs(app, a.host, m.email);
    }
    // DX-089: una recepción que solo atiende en la Sede Norte.
    const restricted = await raw.user.create({
      data: {
        email: 'norte@dx279-a.test',
        passwordHash: (
          await raw.user.findFirstOrThrow({ where: { id: a.adminUserId } })
        ).passwordHash,
        fullName: 'Recepción Norte',
        emailVerifiedAt: new Date(),
      },
    });
    await raw.clinicMembership.create({
      data: {
        tenantId: a.tenantId,
        userId: restricted.id,
        role: ClinicRole.RECEPTION,
      },
    });
    await admin()
      .put(`/staff/${restricted.id}/locations`, { locationIds: [norte] })
      .expect(200);
    norteReception = await loginAs(app, a.host, 'norte@dx279-a.test');
    patient = (
      await raw.patient.create({
        data: {
          tenantId: a.tenantId,
          firstName: 'Ana',
          lastName: 'Incumplida',
        },
      })
    ).id;
    otherPatient = (
      await raw.patient.create({
        data: { tenantId: a.tenantId, firstName: 'Otro', lastName: 'Paciente' },
      })
    ).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('GET/POST /locations/:id/cancellation-policy', () => {
    it.each([ClinicRole.RECEPTION, ClinicRole.DENTIST, ClinicRole.ASSISTANT])(
      '%s recibe 403 en español al leer y al guardar',
      async (role) => {
        const token = tokens[role]!;
        const read = await api(a, token).get(
          `/locations/${principal}/cancellation-policy`,
        );
        expect(read.status).toBe(403);
        expect(read.body).toMatchObject({
          message: CANCELLATION_POLICY_MESSAGES.forbidden,
        });
        await api(a, token)
          .post(`/locations/${principal}/cancellation-policy`, {
            noticeHours: 24,
          })
          .expect(403);
      },
    );

    it('sin configurar: sin vigente ni historial', async () => {
      const res = await admin()
        .get(`/locations/${principal}/cancellation-policy`)
        .expect(200);
      expect(res.body).toEqual({
        locationId: principal,
        current: null,
        versions: [],
      });
    });

    it.each([
      [{ noticeHours: 169 }, CANCELLATION_POLICY_MESSAGES.noticeHours],
      [{ noticeHours: -1 }, CANCELLATION_POLICY_MESSAGES.noticeHours],
      [{ noticeHours: 1.5 }, CANCELLATION_POLICY_MESSAGES.noticeHours],
      [
        { noticeHours: 24, suggestedFee: -1, currency: 'COP' },
        CANCELLATION_POLICY_MESSAGES.fee,
      ],
      [
        { noticeHours: 24, suggestedFee: 100 },
        CANCELLATION_POLICY_MESSAGES.currencyRequired,
      ],
      [
        { noticeHours: 24, patientText: 'a'.repeat(1001) },
        CANCELLATION_POLICY_MESSAGES.patientText,
      ],
    ])('400 en español: %j', async (body, message) => {
      const res = await admin()
        .post(`/locations/${principal}/cancellation-policy`, body)
        .expect(400);
      expect(JSON.stringify(res.body)).toContain(message);
      expect(await raw.cancellationPolicyVersion.count()).toBe(0);
    });

    it('guardar crea la versión siguiente sin tocar la anterior, y queda auditado', async () => {
      const v1 = (
        await admin()
          .post(`/locations/${principal}/cancellation-policy`, {
            noticeHours: 12,
            patientText: 'Avísanos con 12 horas.',
          })
          .expect(201)
      ).body as PolicyVersion;
      const v2 = (
        await admin()
          .post(`/locations/${principal}/cancellation-policy`, {
            noticeHours: 24,
            suggestedFee: 50000,
            currency: 'cop',
            patientText: 'Avísanos con 24 horas.',
          })
          .expect(201)
      ).body as PolicyVersion;
      expect(v1).toMatchObject({
        version: 1,
        noticeHours: 12,
        suggestedFee: null,
        currency: null,
      });
      expect(v2).toMatchObject({
        version: 2,
        noticeHours: 24,
        suggestedFee: 50000,
        currency: 'COP',
      });
      const res = await admin()
        .get(`/locations/${principal}/cancellation-policy`)
        .expect(200);
      const body = res.body as {
        current: PolicyVersion;
        versions: PolicyVersion[];
      };
      expect(body.current.id).toBe(v2.id);
      expect(
        body.versions.map((v) => [v.version, v.noticeHours, v.patientText]),
      ).toEqual([
        [2, 24, 'Avísanos con 24 horas.'],
        [1, 12, 'Avísanos con 12 horas.'],
      ]);
      const events = await raw.auditEvent.findMany({
        where: { tenantId: a.tenantId, resourceType: 'CANCELLATION_POLICY' },
        orderBy: { occurredAt: 'asc' },
      });
      expect(events.map((e) => [e.action, e.resourceId])).toEqual([
        ['CREATE', v1.id],
        ['CREATE', v2.id],
      ]);
      expect(events[1].metadata).toMatchObject({
        reason: 'CANCELLATION_POLICY_CHANGED',
        params: { id: principal },
      });
    });

    it('una sede de otra clínica: 404 (también para guardar)', async () => {
      await api(b, b.adminToken)
        .get(`/locations/${principal}/cancellation-policy`)
        .expect(404);
      await api(b, b.adminToken)
        .post(`/locations/${principal}/cancellation-policy`, { noticeHours: 1 })
        .expect(404);
      expect(
        await raw.cancellationPolicyVersion.count({
          where: { tenantId: b.tenantId },
        }),
      ).toBe(0);
    });

    it('un id que no es UUID: 400 en español', async () => {
      const res = await admin()
        .get('/locations/no-uuid/cancellation-policy')
        .expect(400);
      expect(res.body).toMatchObject({
        message: CANCELLATION_POLICY_MESSAGES.invalidLocationId,
      });
    });
  });

  describe('cancelar desde la agenda', () => {
    it('recepción no puede cancelar sin origen o sin motivo (400) y la cita no cambia', async () => {
      const id = await appointment(5, principal, otherPatient);
      const sinNada = await api(a, tokens.RECEPTION!)
        .patch(`/appointments/${id}`, { status: 'CANCELLED' })
        .expect(400);
      expect(sinNada.body).toMatchObject({
        message: CANCELLATION_MESSAGES.byKindRequired,
      });
      const sinMotivo = await cancel(id, {
        cancelledByKind: 'STAFF_FOR_PATIENT',
      }).expect(400);
      expect(sinMotivo.body).toMatchObject({
        message: CANCELLATION_MESSAGES.reasonRequired,
      });
      await cancel(id, {
        cancelledByKind: 'PATIENT_LINK',
        cancelReasonCode: 'ILLNESS',
      }).expect(400);
      await cancel(id, {
        cancelledByKind: 'STAFF_FOR_PATIENT',
        cancelReasonCode: 'ILLNESS',
        cancelReasonText: 'a'.repeat(501),
      }).expect(400);
      expect(
        await raw.appointment.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({
        status: 'SCHEDULED',
        cancelledAt: null,
      });
    });

    it('unas horas antes con la política de 24 h: el aviso previo lo dice y la cancelación queda tardía y auditada', async () => {
      const id = await appointment(5);
      const preview = await api(a, tokens.RECEPTION!)
        .get(`/appointments/${id}/cancellation-preview`)
        .expect(200);
      expect(preview.body).toMatchObject({
        lateCancellation: true,
        policy: { version: 2, noticeHours: 24 },
      });
      expectNotice(
        id,
        (preview.body as { noticeMinutes: number }).noticeMinutes,
      );

      const res = await cancel(id, {
        cancelledByKind: 'STAFF_FOR_PATIENT',
        cancelReasonCode: 'TRANSPORT',
        cancelReasonText: '  Sin transporte  ',
      }).expect(200);
      const body = res.body as AppointmentBody;
      expect(body).toMatchObject({
        status: 'CANCELLED',
        cancelledByKind: 'STAFF_FOR_PATIENT',
        cancelReasonCode: 'TRANSPORT',
        cancelReasonText: 'Sin transporte',
        lateCancellation: true,
        policyVersionId: null,
      });
      expectNotice(id, body.noticeMinutes);
      const event = await raw.auditEvent.findFirst({
        where: {
          tenantId: a.tenantId,
          resourceId: id,
          metadata: { path: ['reason'], equals: 'APPOINTMENT_CANCELLED' },
        },
      });
      expect(event?.metadata).toMatchObject({
        cancellation: {
          byKind: 'STAFF_FOR_PATIENT',
          reasonCode: 'TRANSPORT',
          lateCancellation: true,
        },
      });
      expect(JSON.stringify(event?.metadata)).not.toContain('transporte');
    });

    it('origen CLÍNICA nunca es tardía (y no cuenta en el resumen)', async () => {
      const id = await appointment(3);
      const res = await cancel(id, {
        cancelledByKind: 'CLINIC',
        cancelReasonCode: 'CLINIC_RESCHEDULE',
      }).expect(200);
      expect(res.body).toMatchObject({
        cancelledByKind: 'CLINIC',
        lateCancellation: false,
      });
    });

    it('sin política en la sede nunca es tardía', async () => {
      const id = await appointment(1, norte);
      const res = await cancel(id, {
        cancelledByKind: 'STAFF_FOR_PATIENT',
        cancelReasonCode: 'FORGOT',
      }).expect(200);
      expect(res.body).toMatchObject({ lateCancellation: false });
    });

    it('marcar NO_SHOW guarda la hora; reactivar limpia todo', async () => {
      const id = await appointment(-30);
      const noShow = await api(a, tokens.RECEPTION!)
        .patch(`/appointments/${id}`, { status: 'NO_SHOW' })
        .expect(200);
      expect((noShow.body as AppointmentBody).noShowMarkedAt).not.toBeNull();
      const back = await api(a, tokens.RECEPTION!)
        .patch(`/appointments/${id}`, { status: 'SCHEDULED' })
        .expect(200);
      expect(back.body).toMatchObject({
        status: 'SCHEDULED',
        noShowMarkedAt: null,
      });
      await api(a, tokens.RECEPTION!)
        .patch(`/appointments/${id}`, { status: 'NO_SHOW' })
        .expect(200);
    });

    it('M1: el paciente que llegó y se fue (ARRIVED → CANCELLED) no es tardío, con un solo evento de auditoría', async () => {
      const id = await appointment(2);
      await raw.appointment.update({
        where: { id },
        data: {
          status: 'ARRIVED',
          arrivedAt: new Date(),
          preArrivalStatus: 'SCHEDULED',
        },
      });
      const preview = await api(a, tokens.RECEPTION!)
        .get(`/appointments/${id}/cancellation-preview`)
        .expect(200);
      expect(preview.body).toMatchObject({ lateCancellation: false });
      const res = await cancel(id, {
        cancelledByKind: 'STAFF_FOR_PATIENT',
        cancelReasonCode: 'OTHER',
      }).expect(200);
      expect(res.body).toMatchObject({
        status: 'CANCELLED',
        cancelledByKind: 'STAFF_FOR_PATIENT',
        lateCancellation: false,
      });
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          resourceId: id,
          OR: [
            { metadata: { path: ['reason'], equals: 'PATIENT_FLOW' } },
            { metadata: { path: ['reason'], equals: 'APPOINTMENT_CANCELLED' } },
          ],
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toMatchObject({
        reason: 'PATIENT_FLOW',
        cancellation: { byKind: 'STAFF_FOR_PATIENT', lateCancellation: false },
      });
    });

    it('M1: sacar de «Completada» a «Cancelada» no es tardía, con un solo evento (COMPLETED_EXIT)', async () => {
      const id = await appointment(-3);
      await raw.appointment.update({
        where: { id },
        data: { status: 'COMPLETED' },
      });
      const res = await admin()
        .patch(`/appointments/${id}`, {
          status: 'CANCELLED',
          statusReason: 'Se marcó completada por error',
          cancelledByKind: 'STAFF_FOR_PATIENT',
          cancelReasonCode: 'OTHER',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        lateCancellation: false,
        noticeMinutes: 0,
      });
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          resourceId: id,
          OR: [
            { metadata: { path: ['reason'], equals: 'COMPLETED_EXIT' } },
            { metadata: { path: ['reason'], equals: 'APPOINTMENT_CANCELLED' } },
          ],
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toMatchObject({
        reason: 'COMPLETED_EXIT',
        cancellation: { byKind: 'STAFF_FOR_PATIENT', lateCancellation: false },
      });
    });

    it('B1: cancelar y mover en el mismo cambio da 400 en español', async () => {
      const id = await appointment(9, principal, otherPatient);
      const start = new Date(Date.now() + 10 * HOUR);
      const res = await cancel(id, {
        cancelledByKind: 'STAFF_FOR_PATIENT',
        cancelReasonCode: 'ILLNESS',
        start: start.toISOString(),
        end: new Date(start.getTime() + 30 * 60_000).toISOString(),
      }).expect(400);
      expect(res.body).toMatchObject({
        message: CANCELLATION_MESSAGES.cancelAndMove,
      });
      expect(
        await raw.appointment.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({
        status: 'SCHEDULED',
      });
    });

    it('la vista previa: 404 desde otra clínica y 403 a una sede no permitida (DX-089)', async () => {
      const id = await appointment(6, principal, otherPatient);
      await api(b, b.adminToken)
        .get(`/appointments/${id}/cancellation-preview`)
        .expect(404);
      await api(a, norteReception)
        .get(`/appointments/${id}/cancellation-preview`)
        .expect(403);
    });
  });

  describe('enlace público del paciente (DX-005)', () => {
    it('cancelar por el enlace unas horas antes guarda PATIENT_LINK, el aviso y que es tardía (sin motivo)', async () => {
      const id = await appointment(7);
      const link = await admin()
        .post(`/appointments/${id}/confirmation-link`)
        .expect(201);
      const token = (link.body as { url: string }).url.split('/confirmar/')[1];
      await request(app.getHttpServer())
        .post(`/api/v1/public/appointment-confirmations/${token}`)
        .set('X-Tenant-Host', a.host)
        .send({ action: 'cancel' })
        .expect(200);
      const row = await raw.appointment.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({
        status: 'CANCELLED',
        cancelledByKind: 'PATIENT_LINK',
        cancelReasonCode: null,
        lateCancellation: true,
        policyVersionId: null,
      });
      expectNotice(id, row.noticeMinutes);
      expect(row.cancelledAt).not.toBeNull();
    });
  });

  describe('GET /patients/:id/attendance-summary e insignia de la agenda', () => {
    it('cuenta inasistencias y tardías de 12 meses por sede, sin las de la clínica', async () => {
      // Una inasistencia en la Sede Norte (además de la de la principal).
      const id = await appointment(-50, norte);
      await admin()
        .patch(`/appointments/${id}`, { status: 'NO_SHOW' })
        .expect(200);
      // Una inasistencia de hace más de 12 meses no cuenta.
      await raw.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId: principal,
          patientId: patient,
          providerId: a.adminUserId,
          status: 'NO_SHOW',
          start: new Date(Date.now() - 400 * 24 * HOUR),
          end: new Date(Date.now() - 400 * 24 * HOUR + 30 * 60_000),
        },
      });

      const res = await api(a, tokens.DENTIST!)
        .get(`/patients/${patient}/attendance-summary`)
        .expect(200);
      const body = res.body as {
        totals: { noShows: number; lateCancellations: number };
        byLocation: {
          locationId: string;
          noShows: number;
          lateCancellations: number;
        }[];
      };
      // Tardías: la de la agenda y la del enlace (las dos en la principal).
      expect(body.totals).toMatchObject({ noShows: 2, lateCancellations: 2 });
      expect(
        body.byLocation.find((l) => l.locationId === principal),
      ).toMatchObject({
        noShows: 1,
        lateCancellations: 2,
      });
      expect(body.byLocation.find((l) => l.locationId === norte)).toMatchObject(
        {
          noShows: 1,
          lateCancellations: 0,
        },
      );
    });

    it('respeta la restricción por sedes (DX-089): la recepción de la Norte solo ve la Norte', async () => {
      const res = await api(a, norteReception)
        .get(`/patients/${patient}/attendance-summary`)
        .expect(200);
      const body = res.body as {
        totals: { noShows: number; lateCancellations: number };
        byLocation: { locationId: string }[];
      };
      expect(body.byLocation.map((l) => l.locationId)).toEqual([norte]);
      expect(body.totals).toMatchObject({ noShows: 1, lateCancellations: 0 });
    });

    it('la agenda trae la insignia de cada cita, sin el detalle libre del motivo', async () => {
      const res = await admin()
        .get('/appointments', {
          from: new Date(Date.now() - 2 * 24 * HOUR).toISOString(),
          to: new Date(Date.now() + 2 * 24 * HOUR).toISOString(),
          locationId: principal,
        })
        .expect(200);
      const rows = res.body as AppointmentBody[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((row) => row.patientId === patient)).toBe(true);
      for (const row of rows) {
        expect(row.attendance).toEqual(
          row.patientId === patient
            ? { noShows: 2, lateCancellations: 2 }
            : { noShows: 0, lateCancellations: 0 },
        );
        expect(row).not.toHaveProperty('cancelReasonText');
      }
    });

    it('un paciente sin incidencias: todo a cero', async () => {
      const other = await raw.patient.create({
        data: { tenantId: a.tenantId, firstName: 'Sin', lastName: 'Faltas' },
      });
      const res = await admin()
        .get(`/patients/${other.id}/attendance-summary`)
        .expect(200);
      expect(res.body).toMatchObject({
        totals: { appointments: 0, noShows: 0, lateCancellations: 0 },
        byLocation: [],
      });
    });

    it('otra clínica: 404; id inválido: 400', async () => {
      await api(b, b.adminToken)
        .get(`/patients/${patient}/attendance-summary`)
        .expect(404);
      await admin().get('/patients/no-uuid/attendance-summary').expect(400);
    });
  });
});
