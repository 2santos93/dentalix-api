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

// DX-121 en HTTP real: tipos de cita (CRUD solo ADMIN, borrado lógico), agendar
// con tipo, la agenda por columnas (`providerIds[]`) y mover una cita de hora y
// de profesional con sus reglas (409 / 422), la anulación del enlace de
// confirmación y el `audit_event` con el antes y el después.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = new Date(Date.now() + 3 * DAY_MS).toISOString().slice(0, 10);
function at(time: string): string {
  return `${DAY}T${time}:00.000Z`;
}
const FROM = `${DAY}T00:00:00.000Z`;
const TO = new Date(new Date(FROM).getTime() + DAY_MS).toISOString();

interface TypeBody {
  id: string;
  name: string;
  durationMinutes: number;
  color: string;
  active: boolean;
}

interface AppointmentBody {
  id: string;
  providerId: string;
  start: string;
  end: string;
  locationId: string;
  appointmentTypeId: string | null;
  appointmentType: {
    id: string;
    name: string;
    durationMinutes: number;
    color: string;
  } | null;
  confirmationSentAt: string | null;
}

describe('Tipos de cita y agenda en columnas (e2e, DX-121)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let dentist: { userId: string; token: string };
  let reception: { userId: string; token: string };
  let patientId: string;
  let secondPatientId: string;

  const api = () => request(app.getHttpServer());
  const as = (
    req: request.Test,
    token: string,
    host = clinic.host,
  ): request.Test =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);

  async function createPatient(c: Clinic, doc: string): Promise<string> {
    const res = await as(api().post('/api/v1/patients'), c.adminToken, c.host)
      .send({
        firstName: 'Ana',
        lastName: 'Paciente',
        docType: 'CC',
        docNumber: doc,
        sex: 'F',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function createType(
    body: Partial<TypeBody> & { name: string },
  ): Promise<TypeBody> {
    const res = await as(
      api().post('/api/v1/appointment-types'),
      clinic.adminToken,
    )
      .send({ durationMinutes: 30, color: '#0E7490', ...body })
      .expect(201);
    return res.body as TypeBody;
  }

  async function book(
    payload: Record<string, unknown>,
  ): Promise<AppointmentBody> {
    const res = await as(api().post('/api/v1/appointments'), reception.token)
      .send({ patientId, providerId: clinic.adminUserId, ...payload })
      .expect(201);
    return res.body as AppointmentBody;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx121-e2e');
    other = await registerClinic(app, 'dx121-e2e-otra');
    const d = await seedMember(raw, clinic, ClinicRole.DENTIST);
    dentist = {
      userId: d.userId,
      token: await loginAs(app, clinic.host, d.email),
    };
    const r = await seedMember(raw, clinic, ClinicRole.RECEPTION);
    reception = {
      userId: r.userId,
      token: await loginAs(app, clinic.host, r.email),
    };
    // Sede sin restricción de horario: los casos de abajo no dependen del día
    // de la corrida (el de 422 fija su propio horario).
    await as(api().put('/api/v1/locations/schedule'), clinic.adminToken)
      .send({ timezone: 'UTC', ranges: [] })
      .expect(200);
    patientId = await createPatient(clinic, '121001');
    secondPatientId = await createPatient(clinic, '121002');
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('CRUD de tipos', () => {
    it('ADMIN crea, edita y lista; el color se normaliza a mayúsculas', async () => {
      const created = await createType({
        name: 'Limpieza',
        durationMinutes: 45,
        color: '#16a34a',
      });
      expect(created).toMatchObject({ color: '#16A34A', active: true });

      const patched = await as(
        api().patch(`/api/v1/appointment-types/${created.id}`),
        clinic.adminToken,
      )
        .send({ durationMinutes: 40 })
        .expect(200);
      expect((patched.body as TypeBody).durationMinutes).toBe(40);

      const list = await as(
        api().get('/api/v1/appointment-types'),
        reception.token,
      ).expect(200);
      expect((list.body as TypeBody[]).map((t) => t.name)).toContain(
        'Limpieza',
      );
    });

    it('los demás roles leen pero no escriben (403)', async () => {
      await as(api().post('/api/v1/appointment-types'), dentist.token)
        .send({ name: 'X', durationMinutes: 30, color: '#0E7490' })
        .expect(403);
      await as(api().post('/api/v1/appointment-types'), reception.token)
        .send({ name: 'X', durationMinutes: 30, color: '#0E7490' })
        .expect(403);
    });

    it.each([
      [{ color: 'red' }, /#RRGGBB/],
      [{ color: '#0E7490; background:url(x)' }, /#RRGGBB/],
      [{ durationMinutes: 32 }, /múltiplo de 5/],
      [{ durationMinutes: 500 }, /múltiplo de 5/],
    ])('valida %j con 400 en español', async (override, message) => {
      const res = await as(
        api().post('/api/v1/appointment-types'),
        clinic.adminToken,
      )
        .send({
          name: 'Inválido',
          durationMinutes: 30,
          color: '#0E7490',
          ...override,
        })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(message);
    });

    it('nombre repetido: 409', async () => {
      await createType({ name: 'Urgencia' });
      await as(api().post('/api/v1/appointment-types'), clinic.adminToken)
        .send({ name: 'Urgencia', durationMinutes: 30, color: '#0E7490' })
        .expect(409);
    });

    it('un tipo de otra clínica no existe aquí (404)', async () => {
      const foreign = await as(
        api().post('/api/v1/appointment-types'),
        other.adminToken,
        other.host,
      )
        .send({ name: 'Ajeno', durationMinutes: 30, color: '#0E7490' })
        .expect(201);
      await as(
        api().patch(
          `/api/v1/appointment-types/${(foreign.body as TypeBody).id}`,
        ),
        clinic.adminToken,
      )
        .send({ name: 'Robado' })
        .expect(404);
    });
  });

  describe('agendar con tipo', () => {
    it('«Endodoncia 90 min» fija la hora de fin; desactivarlo no cambia la cita y lo quita del selector', async () => {
      const endo = await createType({
        name: 'Endodoncia',
        durationMinutes: 90,
        color: '#7C3AED',
      });
      const appt = await book({
        start: at('08:00'),
        appointmentTypeId: endo.id,
      });
      expect(appt.end).toBe(at('09:30'));
      expect(appt.appointmentType).toEqual({
        id: endo.id,
        name: 'Endodoncia',
        durationMinutes: 90,
        color: '#7C3AED',
      });

      await as(
        api().patch(`/api/v1/appointment-types/${endo.id}`),
        clinic.adminToken,
      )
        .send({ active: false })
        .expect(200);

      const actives = await as(
        api().get('/api/v1/appointment-types'),
        reception.token,
      ).expect(200);
      expect((actives.body as TypeBody[]).map((t) => t.id)).not.toContain(
        endo.id,
      );
      const all = await as(
        api().get('/api/v1/appointment-types?includeInactive=true'),
        clinic.adminToken,
      ).expect(200);
      expect((all.body as TypeBody[]).map((t) => t.id)).toContain(endo.id);

      const again = await as(
        api().get(`/api/v1/appointments/${appt.id}`),
        reception.token,
      ).expect(200);
      expect(again.body).toMatchObject({
        end: at('09:30'),
        appointmentType: { id: endo.id, color: '#7C3AED' },
      });

      await as(api().post('/api/v1/appointments'), reception.token)
        .send({
          patientId: secondPatientId,
          providerId: clinic.adminUserId,
          start: at('18:00'),
          appointmentTypeId: endo.id,
        })
        .expect(400);
    });

    it('retirar un tipo (DELETE) es lógico: la cita lo conserva', async () => {
      const type = await createType({ name: 'Retirable', durationMinutes: 20 });
      const appt = await book({
        start: at('19:00'),
        appointmentTypeId: type.id,
      });
      await as(
        api().delete(`/api/v1/appointment-types/${type.id}`),
        clinic.adminToken,
      ).expect(204);
      const after = await as(
        api().get(`/api/v1/appointments/${appt.id}`),
        reception.token,
      ).expect(200);
      expect((after.body as AppointmentBody).appointmentType?.name).toBe(
        'Retirable',
      );
    });
  });

  describe('GET /appointments con providerIds[]', () => {
    it('devuelve solo las columnas pedidas', async () => {
      await book({
        patientId: secondPatientId,
        providerId: dentist.userId,
        start: at('11:00'),
        end: at('11:30'),
      });
      const res = await as(
        api()
          .get('/api/v1/appointments')
          .query({ from: FROM, to: TO, providerIds: [dentist.userId] }),
        reception.token,
      ).expect(200);
      const body = res.body as AppointmentBody[];
      expect(body.length).toBeGreaterThan(0);
      expect(body.every((a) => a.providerId === dentist.userId)).toBe(true);
    });

    it('un profesional de otra clínica: 400', async () => {
      await as(
        api()
          .get('/api/v1/appointments')
          .query({ from: FROM, to: TO, providerIds: [other.adminUserId] }),
        reception.token,
      ).expect(400);
    });

    it('más de 12 profesionales: 400', async () => {
      const ids = Array.from({ length: 13 }, () => dentist.userId);
      await as(
        api()
          .get('/api/v1/appointments')
          .query({ from: FROM, to: TO, providerIds: ids }),
        reception.token,
      ).expect(400);
    });
  });

  describe('PATCH: mover a otra hora y otro profesional', () => {
    it('mueve, anula el enlace de confirmación y audita el antes y el después', async () => {
      const appt = await book({ start: at('13:00'), end: at('13:30') });
      const link = await as(
        api().post(`/api/v1/appointments/${appt.id}/confirmation-link`),
        reception.token,
      ).expect(201);
      const token = (link.body as { url: string }).url.split('/confirmar/')[1];

      // Desde aquí, en TODA la clínica, solo puede auditarse el movimiento.
      const t0 = new Date();
      const moved = await as(
        api().patch(`/api/v1/appointments/${appt.id}`),
        reception.token,
      )
        .send({
          providerId: dentist.userId,
          start: at('14:00'),
          end: at('14:30'),
        })
        .expect(200);
      expect(moved.body).toMatchObject({
        providerId: dentist.userId,
        start: at('14:00'),
        confirmationSentAt: null,
      });

      await api()
        .get(`/api/v1/public/appointment-confirmations/${token}`)
        .set('X-Tenant-Host', clinic.host)
        .expect((res) => {
          expect(JSON.stringify(res.body)).toMatch(/EXPIRED/);
        });

      // Desde DX-256 cada POST/PATCH deja además su traza HTTP genérica
      // (UPDATE con changedFields) junto al APPOINTMENT_MOVED con el antes y el
      // después. Tras t0, en toda la clínica, solo esos dos y de esta cita:
      // nada atribuido a otra cita ni duplicado.
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: clinic.tenantId,
          resourceType: 'APPOINTMENT',
          occurredAt: { gte: t0 },
        },
        orderBy: { occurredAt: 'asc' },
      });
      expect(events.map((e) => [e.action, e.resourceId]).sort()).toEqual([
        ['UPDATE', appt.id],
        ['UPDATE', appt.id],
      ]);
      // Y el alta de la cita, una sola vez.
      expect(
        await raw.auditEvent.count({
          where: {
            tenantId: clinic.tenantId,
            resourceType: 'APPOINTMENT',
            resourceId: appt.id,
            action: 'CREATE',
          },
        }),
      ).toBe(1);
      const trace = events.filter(
        (e) =>
          e.action === 'UPDATE' &&
          (e.metadata as { reason?: string }).reason === undefined,
      );
      expect(trace).toHaveLength(1);
      expect(trace[0]).toMatchObject({
        actorUserId: reception.userId,
        actorRole: 'RECEPTION',
      });
      expect(trace[0].metadata).toMatchObject({
        changedFields: ['end', 'providerId', 'start'],
      });
      const moves = events.filter(
        (e) =>
          (e.metadata as { reason?: string }).reason === 'APPOINTMENT_MOVED',
      );
      expect(moves).toHaveLength(1);
      expect(moves[0]).toMatchObject({
        action: 'UPDATE',
        resourceId: appt.id,
        actorUserId: reception.userId,
        actorRole: 'RECEPTION',
        patientId,
        metadata: {
          reason: 'APPOINTMENT_MOVED',
          move: {
            from: {
              start: at('13:00'),
              end: at('13:30'),
              providerId: clinic.adminUserId,
            },
            to: {
              start: at('14:00'),
              end: at('14:30'),
              providerId: dentist.userId,
            },
          },
        },
      });
    });

    it('cambiar SOLO de profesional (misma hora) también revoca el enlace', async () => {
      const appt = await book({ start: at('15:00'), end: at('15:30') });
      const link = await as(
        api().post(`/api/v1/appointments/${appt.id}/confirmation-link`),
        reception.token,
      ).expect(201);
      const token = (link.body as { url: string }).url.split('/confirmar/')[1];

      await as(api().patch(`/api/v1/appointments/${appt.id}`), reception.token)
        .send({ providerId: dentist.userId })
        .expect(200);

      const res = await api()
        .get(`/api/v1/public/appointment-confirmations/${token}`)
        .set('X-Tenant-Host', clinic.host);
      expect(JSON.stringify(res.body)).toMatch(/EXPIRED/);
    });

    it('sobre otra cita del profesional: 409 en español y la cita no cambia', async () => {
      const busy = await book({
        patientId: secondPatientId,
        providerId: dentist.userId,
        start: at('16:00'),
        end: at('16:30'),
      });
      const appt = await book({ start: at('16:00'), end: at('16:30') });

      const res = await as(
        api().patch(`/api/v1/appointments/${appt.id}`),
        reception.token,
      )
        .send({ providerId: busy.providerId })
        .expect(409);
      expect((res.body as { message: string }).message).toBe(
        'El profesional ya tiene una cita en ese horario',
      );
      const unchanged = await as(
        api().get(`/api/v1/appointments/${appt.id}`),
        reception.token,
      ).expect(200);
      expect((unchanged.body as AppointmentBody).providerId).toBe(
        clinic.adminUserId,
      );
    });

    it('a un profesional de otra clínica: 404', async () => {
      const appt = await book({ start: at('17:00'), end: at('17:30') });
      await as(api().patch(`/api/v1/appointments/${appt.id}`), reception.token)
        .send({ providerId: other.adminUserId })
        .expect(404);
    });

    it('fuera del horario de la sede: 422 con el horario del día', async () => {
      const appt = await book({ start: at('10:00'), end: at('10:30') });
      await as(api().put('/api/v1/locations/schedule'), clinic.adminToken)
        .send({
          timezone: 'UTC',
          ranges: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
            weekday,
            startMinute: 9 * 60,
            endMinute: 12 * 60,
          })),
        })
        .expect(200);
      try {
        const res = await as(
          api().patch(`/api/v1/appointments/${appt.id}`),
          reception.token,
        )
          .send({ start: at('20:00'), end: at('20:30') })
          .expect(422);
        expect((res.body as { message: string }).message).toMatch(
          /Fuera del horario de atención/,
        );
      } finally {
        await as(api().put('/api/v1/locations/schedule'), clinic.adminToken)
          .send({ timezone: 'UTC', ranges: [] })
          .expect(200);
      }
    });
  });
});
