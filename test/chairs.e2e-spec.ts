import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
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
  REGIONAL_BOGOTA_FIXTURE,
  locationBody,
} from './support/location-fixtures';

// DX-211 en HTTP real: sillones por sede (CRUD solo ADMIN, desactivar en vez
// de borrar, auditado), el sillón como recurso de la cita (409 por sillón con
// su nombre y las horas de la sede, sillón de otra sede o clínica rechazado,
// desactivado no elegible) y la agenda filtrada por sillón. La clínica B ataca
// con los ids de A (`tenant-id-inputs.ts` cita este spec).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = new Date(Date.now() + 3 * DAY_MS).toISOString().slice(0, 10);
/** Instante UTC; la sede está en Bogotá (UTC−5): 15:00Z son las 10:00. */
const at = (time: string) => `${DAY}T${time}:00.000Z`;
const FROM = `${DAY}T00:00:00.000Z`;
const TO = new Date(new Date(FROM).getTime() + DAY_MS).toISOString();

interface ChairBody {
  id: string;
  locationId: string;
  name: string;
  sortOrder: number;
  defaultProviderId: string | null;
  active: boolean;
}

interface AppointmentBody {
  id: string;
  providerId: string;
  chairId: string | null;
  chair: { id: string; name: string; active: boolean } | null;
}

describe('Sillones por sede y anti-solape por sillón (e2e, DX-211)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let norte: string;
  let sur: string;
  let dentist: { userId: string; token: string };
  let reception: { userId: string; token: string };
  let assistant: { userId: string; token: string };
  const patients: string[] = [];

  const api = () => request(app.getHttpServer());
  const as = (
    req: request.Test,
    token: string,
    host = clinic.host,
  ): request.Test =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);

  async function createChair(
    body: Record<string, unknown>,
    c: Clinic = clinic,
  ): Promise<ChairBody> {
    const res = await as(api().post('/api/v1/chairs'), c.adminToken, c.host)
      .send(body)
      .expect(201);
    return res.body as ChairBody;
  }

  function book(body: Record<string, unknown>, location = norte) {
    return as(api().post('/api/v1/appointments'), reception.token)
      .set('X-Location-Id', location)
      .send({
        patientId: patients[0],
        providerId: dentist.userId,
        start: at('15:00'),
        end: at('15:30'),
        ...body,
      });
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx211-e2e');
    other = await registerClinic(app, 'dx211-e2e-otra');
    norte = (
      (
        await as(api().post('/api/v1/locations'), clinic.adminToken)
          .send(locationBody(REGIONAL_BOGOTA_FIXTURE, { name: 'Sede Norte' }))
          .expect(201)
      ).body as { id: string }
    ).id;
    sur = (
      (
        await as(api().post('/api/v1/locations'), clinic.adminToken)
          .send(locationBody(REGIONAL_BOGOTA_FIXTURE, { name: 'Sede Sur' }))
          .expect(201)
      ).body as { id: string }
    ).id;
    // Sin horario de atención: los casos no dependen del día de la corrida.
    for (const location of [norte, sur]) {
      await as(api().put('/api/v1/locations/schedule'), clinic.adminToken)
        .set('X-Location-Id', location)
        .send({ ranges: [] })
        .expect(200);
    }
    for (const [role, assign] of [
      [ClinicRole.DENTIST, (m: typeof dentist) => (dentist = m)],
      [ClinicRole.RECEPTION, (m: typeof dentist) => (reception = m)],
      [ClinicRole.ASSISTANT, (m: typeof dentist) => (assistant = m)],
    ] as const) {
      const member = await seedMember(raw, clinic, role);
      assign({
        userId: member.userId,
        token: await loginAs(app, clinic.host, member.email),
      });
    }
    for (const doc of ['211001', '211002', '211003', '211004']) {
      const res = await as(api().post('/api/v1/patients'), clinic.adminToken)
        .send({
          firstName: 'Ana',
          lastName: `Paciente ${doc}`,
          docType: 'NATIONAL_ID',
          docNumber: doc,
          sex: 'F',
        })
        .expect(201);
      patients.push((res.body as { id: string }).id);
    }
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('CRUD de sillones', () => {
    it('ADMIN crea «Sillón 1» y «Sillón 2» en Norte; no salen en Sur; queda auditado', async () => {
      const one = await createChair({ locationId: norte, name: 'Sillón 1' });
      const two = await createChair({
        locationId: norte,
        name: ' Sillón 2 ',
        defaultProviderId: dentist.userId,
      });
      expect(two).toMatchObject({
        name: 'Sillón 2',
        sortOrder: 1,
        defaultProviderId: dentist.userId,
        active: true,
      });
      const listNorte = await as(
        api().get('/api/v1/chairs').query({ locationId: norte }),
        reception.token,
      ).expect(200);
      expect((listNorte.body as ChairBody[]).map((c) => c.id)).toEqual([
        one.id,
        two.id,
      ]);
      const listSur = await as(
        api().get('/api/v1/chairs').query({ locationId: sur }),
        reception.token,
      ).expect(200);
      expect(listSur.body).toEqual([]);
      const events = await raw.auditEvent.findMany({
        where: { tenantId: clinic.tenantId, resourceType: 'CHAIR' },
      });
      expect(events.map((e) => [e.action, e.resourceId])).toEqual(
        expect.arrayContaining([
          ['CREATE', one.id],
          ['CREATE', two.id],
        ]),
      );
    });

    it('un nombre duplicado en la misma sede da 409 en español (también sin distinguir mayúsculas)', async () => {
      const res = await as(api().post('/api/v1/chairs'), clinic.adminToken)
        .send({ locationId: norte, name: 'sillón 1' })
        .expect(409);
      expect((res.body as { message: string }).message).toBe(
        'Ya existe un sillón con ese nombre en esta sede.',
      );
      // En Sur el mismo nombre vale.
      await createChair({ locationId: sur, name: 'Sillón 1' });
    });

    it('valida nombre y profesional por defecto con 400 en español', async () => {
      const empty = await as(api().post('/api/v1/chairs'), clinic.adminToken)
        .send({ locationId: norte, name: '   ' })
        .expect(400);
      expect(JSON.stringify(empty.body)).toMatch(/no puede estar vacío/);
      const notAttending = await as(
        api().post('/api/v1/chairs'),
        clinic.adminToken,
      )
        .send({
          locationId: norte,
          name: 'Sillón R',
          defaultProviderId: reception.userId,
        })
        .expect(400);
      expect(JSON.stringify(notAttending.body)).toMatch(/no atiende pacientes/);
    });

    it('los demás roles leen pero no escriben (403)', async () => {
      const [chair] = (
        await as(
          api().get('/api/v1/chairs').query({ locationId: norte }),
          dentist.token,
        ).expect(200)
      ).body as ChairBody[];
      await as(
        api().get('/api/v1/chairs').query({ locationId: norte }),
        assistant.token,
      ).expect(200);
      for (const token of [dentist.token, reception.token, assistant.token]) {
        const denied = await as(api().post('/api/v1/chairs'), token)
          .send({ locationId: norte, name: 'Intruso' })
          .expect(403);
        expect((denied.body as { message: string }).message).toBe(
          'Solo administración gestiona los sillones.',
        );
        await as(api().patch(`/api/v1/chairs/${chair.id}`), token)
          .send({ name: 'Intruso' })
          .expect(403);
        await as(api().post(`/api/v1/chairs/${chair.id}/deactivate`), token)
          .send()
          .expect(403);
        await as(api().put('/api/v1/chairs/order'), token)
          .send({ locationId: norte, chairIds: [chair.id] })
          .expect(403);
      }
    });

    it('renombrar, ordenar y cambiar el profesional por defecto (auditado)', async () => {
      const chairs = (
        await as(
          api().get('/api/v1/chairs').query({ locationId: norte }),
          clinic.adminToken,
        ).expect(200)
      ).body as ChairBody[];
      const [one, two] = chairs;
      const renamed = await as(
        api().patch(`/api/v1/chairs/${one.id}`),
        clinic.adminToken,
      )
        .send({ name: 'Sillón 1', defaultProviderId: clinic.adminUserId })
        .expect(200);
      expect((renamed.body as ChairBody).defaultProviderId).toBe(
        clinic.adminUserId,
      );
      const sorted = await as(
        api().put('/api/v1/chairs/order'),
        clinic.adminToken,
      )
        .send({ locationId: norte, chairIds: [two.id, one.id] })
        .expect(200);
      expect((sorted.body as ChairBody[]).map((c) => c.id)).toEqual([
        two.id,
        one.id,
      ]);
      await as(api().put('/api/v1/chairs/order'), clinic.adminToken)
        .send({ locationId: norte, chairIds: [one.id, two.id] })
        .expect(200);
      // Incompleto: 400.
      await as(api().put('/api/v1/chairs/order'), clinic.adminToken)
        .send({ locationId: norte, chairIds: [one.id] })
        .expect(400);
      const reasons = (
        await raw.auditEvent.findMany({
          where: {
            tenantId: clinic.tenantId,
            resourceType: 'CHAIR',
            action: 'UPDATE',
          },
        })
      ).map((e) => (e.metadata as { reason?: string } | null)?.reason ?? null);
      expect(reasons).toEqual(expect.arrayContaining([null, 'CHAIR_ORDER']));
    });
  });

  describe('el sillón en la cita', () => {
    let one: ChairBody;
    let two: ChairBody;
    let surChair: ChairBody;

    beforeAll(async () => {
      const chairs = (
        await as(
          api().get('/api/v1/chairs').query({ locationId: norte }),
          clinic.adminToken,
        ).expect(200)
      ).body as ChairBody[];
      [one, two] = chairs;
      [surChair] = (
        await as(
          api().get('/api/v1/chairs').query({ locationId: sur }),
          clinic.adminToken,
        ).expect(200)
      ).body as ChairBody[];
    });

    it('dos profesionales en el mismo sillón y franja: la segunda da 409 con el nombre y las horas de la sede', async () => {
      const first = await book({ chairId: one.id }).expect(201);
      expect(first.body as AppointmentBody).toMatchObject({
        chairId: one.id,
        chair: { id: one.id, name: 'Sillón 1', active: true },
      });
      const clash = await book({
        chairId: one.id,
        providerId: clinic.adminUserId,
        patientId: patients[1],
        start: at('15:15'),
        end: at('15:45'),
      }).expect(409);
      expect((clash.body as { message: string }).message).toBe(
        'El sillón «Sillón 1» ya está ocupado de 10:00 a 10:30',
      );
    });

    it('en sillones distintos, las dos se guardan; sin sillón, nada cambia', async () => {
      await book({
        chairId: two.id,
        providerId: clinic.adminUserId,
        patientId: patients[1],
      }).expect(201);
      await book({
        providerId: clinic.adminUserId,
        patientId: patients[2],
        start: at('17:00'),
        end: at('17:30'),
      }).expect(201);
      const res = await book({
        patientId: patients[3],
        start: at('17:00'),
        end: at('17:30'),
      }).expect(201);
      expect(res.body as AppointmentBody).toMatchObject({
        chairId: null,
        chair: null,
      });
    });

    it('sin profesional, se toma el del sillón', async () => {
      // «Sillón 2» tiene a la dentista por defecto.
      const res = await as(api().post('/api/v1/appointments'), reception.token)
        .set('X-Location-Id', norte)
        .send({
          patientId: patients[2],
          chairId: two.id,
          start: at('19:00'),
          end: at('19:30'),
        })
        .expect(201);
      expect((res.body as AppointmentBody).providerId).toBe(dentist.userId);
    });

    it('un sillón de la sede Sur en una cita de Norte: 400 en español', async () => {
      const res = await book({
        chairId: surChair.id,
        patientId: patients[3],
        start: at('20:00'),
        end: at('20:30'),
      }).expect(400);
      expect((res.body as { message: string }).message).toBe(
        'El sillón «Sillón 1» es de otra sede: elige un sillón de la sede de la cita',
      );
    });

    it('reprogramar al hueco ocupado del sillón: 409; cambiar de sillón a uno libre: 200', async () => {
      const mine = (
        await book({
          chairId: two.id,
          providerId: clinic.adminUserId,
          patientId: patients[3],
          start: at('21:00'),
          end: at('21:30'),
        }).expect(201)
      ).body as AppointmentBody;
      const clash = await as(
        api().patch(`/api/v1/appointments/${mine.id}`),
        reception.token,
      )
        .send({ start: at('19:00'), end: at('19:30') })
        .expect(409);
      expect((clash.body as { message: string }).message).toBe(
        'El sillón «Sillón 2» ya está ocupado de 14:00 a 14:30',
      );
      const moved = await as(
        api().patch(`/api/v1/appointments/${mine.id}`),
        reception.token,
      )
        .send({ chairId: one.id })
        .expect(200);
      expect((moved.body as AppointmentBody).chairId).toBe(one.id);
      // Otra cita ocupa ahora «Sillón 2» a esa hora: volver a él da 409.
      await book({
        chairId: two.id,
        patientId: patients[0],
        start: at('21:00'),
        end: at('21:30'),
      }).expect(201);
      const occupied = await as(
        api().patch(`/api/v1/appointments/${mine.id}`),
        reception.token,
      )
        .send({ chairId: two.id })
        .expect(409);
      expect((occupied.body as { message: string }).message).toBe(
        'El sillón «Sillón 2» ya está ocupado de 16:00 a 16:30',
      );
    });

    it('la agenda filtra por chairIds; un sillón de otra sede da 400', async () => {
      const res = await as(api().get('/api/v1/appointments'), reception.token)
        .query({ from: FROM, to: TO, locationId: norte, chairIds: one.id })
        .expect(200);
      const rows = res.body as AppointmentBody[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.chairId === one.id)).toBe(true);
      const bad = await as(api().get('/api/v1/appointments'), reception.token)
        .query({ from: FROM, to: TO, locationId: norte, chairIds: surChair.id })
        .expect(400);
      expect((bad.body as { message: string }).message).toBe(
        'Algún sillón no es de esta sede',
      );
    });

    it('un sillón desactivado no se elige en citas nuevas, pero sus citas lo muestran inactivo', async () => {
      const chair = await createChair({ locationId: norte, name: 'Sillón 3' });
      const appt = (
        await book({
          chairId: chair.id,
          patientId: patients[0],
          start: at('22:00'),
          end: at('22:30'),
        }).expect(201)
      ).body as AppointmentBody;
      const off = await as(
        api().post(`/api/v1/chairs/${chair.id}/deactivate`),
        clinic.adminToken,
      ).expect(200);
      expect((off.body as ChairBody).active).toBe(false);
      const rejected = await book({
        chairId: chair.id,
        patientId: patients[1],
        start: at('23:00'),
        end: at('23:30'),
      }).expect(400);
      expect((rejected.body as { message: string }).message).toBe(
        'El sillón «Sillón 3» está desactivado: elige otro sillón',
      );
      const detail = await as(
        api().get(`/api/v1/appointments/${appt.id}`),
        reception.token,
      ).expect(200);
      expect((detail.body as AppointmentBody).chair).toEqual({
        id: chair.id,
        name: 'Sillón 3',
        active: false,
      });
      // Sale de la lista por defecto, pero no se borró.
      const active = (
        await as(
          api().get('/api/v1/chairs').query({ locationId: norte }),
          reception.token,
        ).expect(200)
      ).body as ChairBody[];
      expect(active.map((c) => c.id)).not.toContain(chair.id);
      const all = (
        await as(
          api()
            .get('/api/v1/chairs')
            .query({ locationId: norte, includeInactive: true }),
          clinic.adminToken,
        ).expect(200)
      ).body as ChairBody[];
      expect(all.map((c) => c.id)).toContain(chair.id);
      const deactivated = await raw.auditEvent.findMany({
        where: {
          tenantId: clinic.tenantId,
          resourceType: 'CHAIR',
          resourceId: chair.id,
          action: 'UPDATE',
        },
      });
      expect(
        deactivated.map((e) => (e.metadata as { reason?: string }).reason),
      ).toEqual(['CHAIR_DEACTIVATED']);
      await as(
        api().post(`/api/v1/chairs/${chair.id}/reactivate`),
        clinic.adminToken,
      ).expect(200);
    });
  });

  describe('revisión: cambiar solo el sillón no es reagendar (A1)', () => {
    let one: ChairBody;
    let two: ChairBody;

    beforeAll(async () => {
      [one, two] = (
        await as(
          api().get('/api/v1/chairs').query({ locationId: norte }),
          clinic.adminToken,
        ).expect(200)
      ).body as ChairBody[];
    });

    function moveChair(
      appt: { id: string; start: string; end: string; providerId: string },
      chairId: string,
    ) {
      // Lo que manda «Mover a…»: fecha, hora y profesional iguales y el sillón nuevo.
      return as(
        api().patch(`/api/v1/appointments/${appt.id}`),
        reception.token,
      ).send({
        start: appt.start,
        end: appt.end,
        providerId: appt.providerId,
        chairId,
      });
    }

    it('tras cambiar solo el sillón, el enlace de confirmación sin responder sigue vigente', async () => {
      const appt = (
        await book({
          chairId: one.id,
          patientId: patients[2],
          start: at('12:00'),
          end: at('12:30'),
        }).expect(201)
      ).body as AppointmentBody & { start: string; end: string };
      await as(
        api().post(`/api/v1/appointments/${appt.id}/confirmation-link`),
        reception.token,
      ).expect(201);
      const moved = await moveChair(appt, two.id).expect(200);
      expect((moved.body as AppointmentBody).chairId).toBe(two.id);
      const confirmations = await raw.appointmentConfirmation.findMany({
        where: { appointmentId: appt.id },
      });
      expect(confirmations).toHaveLength(1);
      expect(confirmations[0].revokedAt).toBeNull();
      const row = await raw.appointment.findUniqueOrThrow({
        where: { id: appt.id },
      });
      expect(row.confirmationSentAt).not.toBeNull();
    });

    it('se cambia el sillón de una cita de hoy con el paciente ya en la clínica', async () => {
      const appt = (
        await book({
          chairId: one.id,
          patientId: patients[3],
          start: at('13:00'),
          end: at('13:30'),
        }).expect(201)
      ).body as AppointmentBody & { start: string; end: string };
      // Se trae a HOY (empezó hace 5 min) por `raw`: agendar en el pasado no se puede.
      const start = new Date(Date.now() - 5 * 60_000);
      const end = new Date(start.getTime() + 30 * 60_000);
      await raw.appointment.update({
        where: { id: appt.id },
        data: { start, end },
      });
      await as(api().patch(`/api/v1/appointments/${appt.id}`), reception.token)
        .send({ status: 'ARRIVED' })
        .expect(200);
      const moved = await moveChair(
        {
          ...appt,
          start: start.toISOString(),
          end: end.toISOString(),
        },
        two.id,
      ).expect(200);
      expect(moved.body as AppointmentBody & { status: string }).toMatchObject({
        chairId: two.id,
        status: 'ARRIVED',
      });
    });
  });

  describe('aislamiento entre clínicas', () => {
    let chairA: ChairBody;
    let locationB: string;

    beforeAll(async () => {
      [chairA] = (
        await as(
          api().get('/api/v1/chairs').query({ locationId: norte }),
          clinic.adminToken,
        ).expect(200)
      ).body as ChairBody[];
      const main = await raw.location.findFirstOrThrow({
        where: { tenantId: other.tenantId },
      });
      locationB = main.id;
      await as(
        api().put('/api/v1/locations/schedule'),
        other.adminToken,
        other.host,
      )
        .send({ ranges: [] })
        .expect(200);
    });

    async function snapshotA() {
      return raw.chair.findMany({
        where: { tenantId: clinic.tenantId },
        orderBy: { id: 'asc' },
      });
    }

    it('B no lee, edita, ordena ni desactiva los sillones de A (404/400) y nada de A cambia', async () => {
      const before = await snapshotA();
      await as(
        api().patch(`/api/v1/chairs/${chairA.id}`),
        other.adminToken,
        other.host,
      )
        .send({ name: 'Robado' })
        .expect(404);
      await as(
        api().post(`/api/v1/chairs/${chairA.id}/deactivate`),
        other.adminToken,
        other.host,
      ).expect(404);
      await as(
        api().get('/api/v1/chairs').query({ locationId: norte }),
        other.adminToken,
        other.host,
      ).expect(404);
      await as(api().post('/api/v1/chairs'), other.adminToken, other.host)
        .send({ locationId: norte, name: 'En la sede de A' })
        .expect(404);
      const orderRes = await as(
        api().put('/api/v1/chairs/order'),
        other.adminToken,
        other.host,
      )
        .send({ locationId: locationB, chairIds: [chairA.id] })
        .expect(400);
      expect((orderRes.body as { message: string }).message).toBe(
        'Envía todos los sillones de la sede, cada uno una vez',
      );
      await as(api().put('/api/v1/chairs/order'), other.adminToken, other.host)
        .send({ locationId: norte, chairIds: [chairA.id] })
        .expect(404);
      expect(await snapshotA()).toEqual(before);
    });

    it('B no puede usar al profesional de A como profesional por defecto (404)', async () => {
      const res = await as(
        api().post('/api/v1/chairs'),
        other.adminToken,
        other.host,
      )
        .send({
          locationId: locationB,
          name: 'Sillón B',
          defaultProviderId: dentist.userId,
        })
        .expect(404);
      expect((res.body as { message: string }).message).toBe(
        'Profesional no encontrado',
      );
      const own = await createChair(
        { locationId: locationB, name: 'Sillón B' },
        other,
      );
      await as(
        api().patch(`/api/v1/chairs/${own.id}`),
        other.adminToken,
        other.host,
      )
        .send({ defaultProviderId: dentist.userId })
        .expect(404);
    });

    it('una cita de B con el sillón de A: 404 «Sillón no encontrado»; la agenda de B con ese sillón: 400', async () => {
      const patientB = (
        (
          await as(api().post('/api/v1/patients'), other.adminToken, other.host)
            .send({
              firstName: 'Luis',
              lastName: 'Ajeno',
              docType: 'NATIONAL_ID',
              docNumber: '211900',
              sex: 'M',
            })
            .expect(201)
        ).body as { id: string }
      ).id;
      const res = await as(
        api().post('/api/v1/appointments'),
        other.adminToken,
        other.host,
      )
        .send({
          patientId: patientB,
          providerId: other.adminUserId,
          chairId: chairA.id,
          start: at('15:00'),
          end: at('15:30'),
        })
        .expect(404);
      expect((res.body as { message: string }).message).toBe(
        'Sillón no encontrado',
      );
      const appt = (
        await as(
          api().post('/api/v1/appointments'),
          other.adminToken,
          other.host,
        )
          .send({
            patientId: patientB,
            providerId: other.adminUserId,
            start: at('15:00'),
            end: at('15:30'),
          })
          .expect(201)
      ).body as AppointmentBody;
      await as(
        api().patch(`/api/v1/appointments/${appt.id}`),
        other.adminToken,
        other.host,
      )
        .send({ chairId: chairA.id })
        .expect(404);
      const list = await as(
        api().get('/api/v1/appointments'),
        other.adminToken,
        other.host,
      )
        .query({
          from: FROM,
          to: TO,
          locationId: locationB,
          chairIds: chairA.id,
        })
        .expect(400);
      expect((list.body as { message: string }).message).toBe(
        'Algún sillón no es de esta sede',
      );
    });
  });
});
