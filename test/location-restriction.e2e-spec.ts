import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient, Sex } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  SEEDED_PASSWORD,
  STAFF_CANCELLATION,
} from './support/e2e-fixtures';
import { TokenService } from '../src/shared/crypto/token.service';
import { PasswordService } from '../src/shared/crypto/password.service';
import {
  LOCATION_NOT_ALLOWED_CODE,
  LOCATION_NOT_ALLOWED_MESSAGE,
} from '../src/shared/tenancy/location-access';
import {
  LOCATION_INACTIVE_CODE,
  LOCATION_INACTIVE_MESSAGE,
} from '../src/shared/tenancy/active-location';
import { PROVIDER_NOT_AT_LOCATION_MESSAGE } from '../src/modules/staff/domain/provider-location';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationBody,
} from './support/location-fixtures';
import { seedDefaultRecallTypes } from './support/recall-types';

// DX-089: el personal restringido a sedes solo ve y escribe en las suyas, y un
// profesional restringido solo atiende en sus sedes (DX-121d).
//
// Clínica A con tres sedes (A1 la principal, A2 y A3):
// - R  (recepción) restringida a A1: con UNA sede el interceptor la fija.
// - R2 (recepción) restringida a A2 y A3: sin cabecera ve el conjunto.
// - S  (asistente) restringida a A1 (inventario).
// - D  (odontólogo) restringido a A1; E (odontóloga) sin restricción.
// - U  (recepción) SIN filas: tiene que ver exactamente lo de siempre.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const passwords = new PasswordService();

interface Member {
  userId: string;
  email: string;
}

const PERIOD = { from: '2026-09-01', to: '2026-09-30' };
const RANGE = {
  from: '2027-03-01T00:00:00.000Z',
  to: '2027-03-31T00:00:00.000Z',
};

describe('Personal restringido a sedes (DX-089)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let a1: string;
  let a2: string;
  let a3: string;
  let r: Member;
  let r2: Member;
  let s: Member;
  let d: Member;
  let e: Member;
  let u: Member;
  let f: Member;
  const tokens: Record<string, string> = {};
  let patient: string;
  let plan: string;
  const appt: Record<string, string> = {};
  const item: Record<string, string> = {};
  const block: Record<string, string> = {};
  const followUpPlan: Record<string, string> = {};
  const waitlist: Record<string, string> = {};
  let cashA1: string;

  function api(token: string, locationId?: string) {
    const server = app.getHttpServer();
    const auth = (t: request.Test) => {
      const withAuth = t
        .set('X-Tenant-Host', a.host)
        .set('Authorization', `Bearer ${token}`);
      return locationId ? withAuth.set('X-Location-Id', locationId) : withAuth;
    };
    return {
      get: (path: string, query: object = {}) =>
        auth(request(server).get(`/api/v1${path}`)).query(query),
      post: (path: string, body: object) =>
        auth(request(server).post(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) =>
        auth(request(server).patch(`/api/v1${path}`)).send(body),
      delete: (path: string, body: object) =>
        auth(request(server).delete(`/api/v1${path}`)).send(body),
      put: (path: string, body: object) =>
        auth(request(server).put(`/api/v1${path}`)).send(body),
    };
  }
  const admin = () => api(a.adminToken);

  async function seedUser(email: string, role: ClinicRole): Promise<Member> {
    const user = await raw.user.create({
      data: {
        email,
        passwordHash: await passwords.hash(SEEDED_PASSWORD),
        fullName: `Miembro ${email}`,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    await raw.clinicMembership.create({
      data: { tenantId: a.tenantId, userId: user.id, role },
    });
    return { userId: user.id, email };
  }

  async function restrict(member: Member, locationIds: string[]) {
    await admin()
      .put(`/staff/${member.userId}/locations`, { locationIds })
      .expect(200);
  }

  async function createPatient(docNumber: string): Promise<string> {
    const res = await admin()
      .post('/patients', {
        firstName: 'Paciente',
        lastName: docNumber,
        docType: 'NATIONAL_ID',
        docNumber,
        sex: Sex.F,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  function expectNotAllowed(res: request.Response) {
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: LOCATION_NOT_ALLOWED_CODE,
      message: LOCATION_NOT_ALLOWED_MESSAGE,
    });
  }

  const ids = (body: unknown) =>
    (body as { id: string }[]).map((row) => row.id).sort();
  const itemIds = (body: unknown) => ids((body as { items: unknown }).items);
  // Ids y total de un listado (array o página): `canVoid` y similares van
  // por quien consulta, así que no se comparan.
  const rowsOf = (body: unknown) => {
    const rows = Array.isArray(body)
      ? (body as { id?: string; planId?: string }[])
      : (body as { items: { id?: string; planId?: string }[] }).items;
    return {
      total: Array.isArray(body)
        ? rows.length
        : (body as { total: number }).total,
      ids: rows.map((row) => row.id ?? row.planId).sort(),
    };
  };
  const planIds = (body: unknown) =>
    (body as { items: { planId: string }[] }).items
      .map((row) => row.planId)
      .sort();

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx089-restr-a');
    a1 = (
      (await admin().get('/locations').expect(200)).body as { id: string }[]
    )[0].id;
    const newLocation = async (name: string) =>
      (
        (
          await admin()
            .post(
              '/locations',
              locationBody(REGIONAL_CARACAS_FIXTURE, { name }),
            )
            .expect(201)
        ).body as {
          id: string;
        }
      ).id;
    a2 = await newLocation('Sede Norte');
    a3 = await newLocation('Sede Sur');

    r = await seedUser('r@dx089-restr-a.test', ClinicRole.RECEPTION);
    r2 = await seedUser('r2@dx089-restr-a.test', ClinicRole.RECEPTION);
    s = await seedUser('s@dx089-restr-a.test', ClinicRole.ASSISTANT);
    d = await seedUser('d@dx089-restr-a.test', ClinicRole.DENTIST);
    e = await seedUser('e@dx089-restr-a.test', ClinicRole.DENTIST);
    u = await seedUser('u@dx089-restr-a.test', ClinicRole.RECEPTION);
    // F atiende solo en A2: no en la sede principal.
    f = await seedUser('f@dx089-restr-a.test', ClinicRole.DENTIST);
    await restrict(r, [a1]);
    await restrict(r2, [a2, a3]);
    await restrict(s, [a1]);
    await restrict(d, [a1]);
    await restrict(f, [a2]);
    // El login lee las sedes vigentes: el token ya lleva `loc`.
    for (const m of [r, r2, s, d, e, u]) {
      tokens[m.email] = await loginAs(app, a.host, m.email);
    }

    const t = { tenantId: a.tenantId };
    patient = await createPatient('DX089-1');
    plan = (
      await raw.treatmentPlan.create({
        data: { ...t, patientId: patient, currency: 'USD', status: 'ACCEPTED' },
      })
    ).id;
    // Citas de E en las tres sedes (marzo de 2027).
    for (const [key, locationId, hour] of [
      ['a1', a1, 15],
      ['a2', a2, 16],
      ['a3', a3, 17],
    ] as const) {
      appt[key] = (
        await raw.appointment.create({
          data: {
            ...t,
            locationId,
            patientId: patient,
            providerId: e.userId,
            start: new Date(`2027-03-03T${hour}:00:00.000Z`),
            end: new Date(`2027-03-03T${hour}:30:00.000Z`),
          },
        })
      ).id;
    }
    // Abonos de septiembre de 2026, uno por sede.
    for (const locationId of [a1, a2, a3]) {
      await raw.payment.create({
        data: {
          ...t,
          locationId,
          treatmentPlanId: plan,
          patientId: patient,
          amount: 1000,
          currency: 'USD',
          paidAt: new Date('2026-09-15T17:00:00.000Z'),
        },
      });
    }
    for (const [key, locationId] of [
      ['a1', a1],
      ['a2', a2],
    ] as const) {
      item[key] = (
        await raw.inventoryItem.create({
          data: { ...t, locationId, name: `Guantes ${key}`, unit: 'caja' },
        })
      ).id;
    }
    for (const [key, locationId, providerId] of [
      ['a1', a1, null],
      ['a2', a2, null],
      ['all', null, e.userId],
    ] as const) {
      block[key] = (
        await raw.scheduleBlock.create({
          data: {
            ...t,
            locationId,
            providerId,
            kind: 'MEETING',
            start: new Date('2027-03-10T15:00:00.000Z'),
            end: new Date('2027-03-10T16:00:00.000Z'),
          },
        })
      ).id;
    }
    // Presupuestos presentados hace 30 días, sin cita futura.
    for (const [key, locationId] of [
      ['a1', a1],
      ['a2', a2],
    ] as const) {
      const p = await createPatient(`DX089-F-${key}`);
      followUpPlan[key] = (
        await raw.treatmentPlan.create({
          data: {
            ...t,
            patientId: p,
            currency: 'USD',
            status: 'PRESENTED',
            presentedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000),
            presentedLocationId: locationId,
          },
        })
      ).id;
      waitlist[key] = (
        await raw.appointmentWaitlistEntry.create({
          data: { ...t, locationId, patientId: p },
        })
      ).id;
    }
    cashA1 = (
      await raw.cashSession.create({
        data: { ...t, locationId: a1, openedById: r2.userId },
      })
    ).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await app.close();
  });

  const as = (m: Member, locationId?: string) =>
    api(tokens[m.email], locationId);

  describe('sedes visibles', () => {
    it('GET /locations: solo las permitidas al restringido; todas a los demás', async () => {
      expect(ids((await as(r).get('/locations').expect(200)).body)).toEqual(
        [a1].sort(),
      );
      expect(ids((await as(r2).get('/locations').expect(200)).body)).toEqual(
        [a2, a3].sort(),
      );
      const all = [a1, a2, a3].sort();
      expect(ids((await admin().get('/locations').expect(200)).body)).toEqual(
        all,
      );
      expect(ids((await as(u).get('/locations').expect(200)).body)).toEqual(
        all,
      );
    });
  });

  describe('agenda', () => {
    it('una sede no permitida (query o cabecera) es 403 con code', async () => {
      expectNotAllowed(
        await as(r).get('/appointments', { ...RANGE, locationId: a2 }),
      );
      expectNotAllowed(await as(r, a2).get('/appointments', RANGE));
    });

    it('sin cabecera solo las citas de sus sedes', async () => {
      expect(
        ids((await as(r).get('/appointments', RANGE).expect(200)).body),
      ).toEqual([appt.a1]);
      expect(
        ids((await as(r2).get('/appointments', RANGE).expect(200)).body),
      ).toEqual([appt.a2, appt.a3].sort());
    });

    it('una cita de otra sede por id es 403 (leer y editar)', async () => {
      expectNotAllowed(await as(r).get(`/appointments/${appt.a2}`));
      expectNotAllowed(
        await as(r).patch(`/appointments/${appt.a2}`, { notes: 'x' }),
      );
      await as(r).get(`/appointments/${appt.a1}`).expect(200);
    });

    it('crear una cita en una sede no permitida es 403', async () => {
      expectNotAllowed(
        await as(r2, a1).post('/appointments', {
          patientId: patient,
          providerId: e.userId,
          start: '2027-03-05T15:00:00.000Z',
          end: '2027-03-05T15:30:00.000Z',
        }),
      );
    });

    it('agendar desde pendientes de otra sede es 403', async () => {
      expectNotAllowed(
        await as(r2).post(`/waitlist/${waitlist.a1}/schedule`, {
          providerId: e.userId,
          start: '2027-03-05T16:00:00.000Z',
        }),
      );
    });

    it('huecos de una sede no permitida es 403', async () => {
      expectNotAllowed(
        await as(r2).get('/appointments/openings', {
          providerId: e.userId,
          locationId: a1,
          from: '2027-03-01',
          to: '2027-03-05',
          durationMinutes: 30,
        }),
      );
    });
  });

  describe('profesional ↔ sede (DX-121d)', () => {
    it('columnas con un profesional que no atiende en la sede: 400', async () => {
      const res = await admin()
        .get('/appointments', {
          ...RANGE,
          locationId: a2,
          providerIds: [d.userId],
        })
        .expect(400);
      expect((res.body as { message: string }).message).toBe(
        PROVIDER_NOT_AT_LOCATION_MESSAGE,
      );
      await admin()
        .get('/appointments', {
          ...RANGE,
          locationId: a1,
          providerIds: [d.userId],
        })
        .expect(200);
      // Sin sede objetivo no se comprueba.
      await admin()
        .get('/appointments', { ...RANGE, providerIds: [d.userId] })
        .expect(200);
    });

    it('huecos de un profesional que no atiende en la sede: 400', async () => {
      const res = await admin()
        .get('/appointments/openings', {
          providerId: d.userId,
          locationId: a2,
          from: '2027-03-01',
          to: '2027-03-05',
          durationMinutes: 30,
        })
        .expect(400);
      expect((res.body as { message: string }).message).toBe(
        PROVIDER_NOT_AT_LOCATION_MESSAGE,
      );
    });

    it('crear una cita de D en A2 es 400; de E en A2, 201', async () => {
      const body = {
        patientId: patient,
        start: '2027-03-04T15:00:00.000Z',
        end: '2027-03-04T15:30:00.000Z',
      };
      const res = await api(a.adminToken, a2)
        .post('/appointments', { ...body, providerId: d.userId })
        .expect(400);
      expect((res.body as { message: string }).message).toBe(
        PROVIDER_NOT_AT_LOCATION_MESSAGE,
      );
      const created = await api(a.adminToken, a2)
        .post('/appointments', { ...body, providerId: e.userId })
        .expect(201);
      expect((created.body as { locationId: string }).locationId).toBe(a2);
      await raw.appointment.delete({
        where: { id: (created.body as { id: string }).id },
      });
    });

    it('sin cabecera se comprueba contra la sede donde se escribe la cita', async () => {
      const body = {
        patientId: patient,
        start: '2027-03-08T15:00:00.000Z',
        end: '2027-03-08T15:30:00.000Z',
      };
      // R2 (A2 y A3) escribe en A2, donde D (solo A1) no atiende.
      const restricted = await as(r2)
        .post('/appointments', { ...body, providerId: d.userId })
        .expect(400);
      expect((restricted.body as { message: string }).message).toBe(
        PROVIDER_NOT_AT_LOCATION_MESSAGE,
      );
      // Sin restricción se escribe en la principal (A1), donde F no atiende.
      const unrestricted = await as(u)
        .post('/appointments', { ...body, providerId: f.userId })
        .expect(400);
      expect((unrestricted.body as { message: string }).message).toBe(
        PROVIDER_NOT_AT_LOCATION_MESSAGE,
      );
    });

    it('mover una cita de A2 a D es 400', async () => {
      const res = await admin()
        .patch(`/appointments/${appt.a2}`, { providerId: d.userId })
        .expect(400);
      expect((res.body as { message: string }).message).toBe(
        PROVIDER_NOT_AT_LOCATION_MESSAGE,
      );
    });
  });

  describe('caja y abonos', () => {
    it('GET /payments con una sede no permitida es 403', async () => {
      expectNotAllowed(await as(r, a2).get('/payments', PERIOD));
    });

    it('sin cabecera, solo los abonos del período de sus sedes', async () => {
      const mine = (await as(r).get('/payments', PERIOD).expect(200)).body as {
        total: number;
        items: { location: { id: string } }[];
      };
      expect(mine.total).toBe(1);
      expect(mine.items.map((i) => i.location.id)).toEqual([a1]);
      const multi = (await as(r2).get('/payments', PERIOD).expect(200))
        .body as { total: number; items: { location: { id: string } }[] };
      expect(multi.total).toBe(2);
      expect(multi.items.map((i) => i.location.id).sort()).toEqual(
        [a2, a3].sort(),
      );
    });

    it('un abono sin cabecera queda en la sede del restringido', async () => {
      const pay = async (m: Member) =>
        (
          (
            await as(m)
              .post(`/treatment-plans/${plan}/payments`, {
                amount: 10,
                currency: 'USD',
                paidAt: '2026-10-01',
              })
              .expect(201)
          ).body as { id: string }
        ).id;
      const locationOf = async (id: string) =>
        (await raw.payment.findUniqueOrThrow({ where: { id } })).locationId;
      expect(await locationOf(await pay(r))).toBe(a1);
      // Con dos sedes: la primera permitida por antigüedad, no la principal.
      expect(await locationOf(await pay(r2))).toBe(a2);
    });

    it('cajas: sede explícita no permitida 403; una caja de otra sede por id 403', async () => {
      expectNotAllowed(await as(r2).get('/cash-sessions', { locationId: a1 }));
      expectNotAllowed(
        await as(r2).post('/cash-sessions/open', {
          locationId: a1,
          floats: [],
        }),
      );
      expectNotAllowed(await as(r2).get(`/cash-sessions/${cashA1}`));
      const list = (await as(r2).get('/cash-sessions').expect(200)).body as {
        items: { id: string }[];
      };
      expect(list.items.map((i) => i.id)).not.toContain(cashA1);
    });

    it('cartera con una sede no permitida es 403', async () => {
      expectNotAllowed(
        await as(r2).get('/receivables/aging', { locationId: a1 }),
      );
    });

    it('compromiso de pago en una sede no permitida es 403', async () => {
      expectNotAllowed(
        await as(r2).post(`/patients/${patient}/payment-promises`, {
          amount: 100,
          currency: 'USD',
          dueDate: '2027-01-15',
          locationId: a1,
        }),
      );
    });
  });

  describe('inventario', () => {
    it('sin cabecera solo los ítems de su sede; un ítem de otra sede por id es 403', async () => {
      expect(
        itemIds((await as(s).get('/inventory/items').expect(200)).body),
      ).toEqual([item.a1]);
      expectNotAllowed(await as(s).get(`/inventory/items/${item.a2}`));
      expectNotAllowed(
        await as(s).patch(`/inventory/items/${item.a2}`, { name: 'x' }),
      );
    });
  });

  describe('bloqueos y pendientes', () => {
    it('sin cabecera, los bloqueos de sus sedes y los de «todas las sedes»', async () => {
      const range = { from: RANGE.from, to: RANGE.to };
      expect(
        ids((await as(r).get('/schedule-blocks', range).expect(200)).body),
      ).toEqual([block.a1, block.all].sort());
      expect(
        ids((await as(r2).get('/schedule-blocks', range).expect(200)).body),
      ).toEqual([block.a2, block.all].sort());
      expectNotAllowed(
        await as(r2).get('/schedule-blocks', { ...range, locationId: a1 }),
      );
    });

    it('solo quien tiene todas las sedes crea un bloqueo «todas las sedes»', async () => {
      const body = {
        providerId: e.userId,
        kind: 'VACATION',
        start: '2027-04-01T00:00:00.000Z',
        end: '2027-04-02T00:00:00.000Z',
      };
      expectNotAllowed(await as(r2).post('/schedule-blocks', body));
      expectNotAllowed(
        await as(r2).post('/schedule-blocks', { ...body, locationId: a1 }),
      );
      await as(r2)
        .post('/schedule-blocks', { ...body, locationId: a2 })
        .expect(201);
      await as(u).post('/schedule-blocks', body).expect(201);
    });

    it('pendientes: sin cabecera los de sus sedes; otra sede explícita 403', async () => {
      expect(itemIds((await as(r).get('/waitlist').expect(200)).body)).toEqual([
        waitlist.a1,
      ]);
      expect(itemIds((await as(r2).get('/waitlist').expect(200)).body)).toEqual(
        [waitlist.a2],
      );
      expectNotAllowed(await as(r2).get('/waitlist', { locationId: a1 }));
    });

    it('presupuestos por seguir: solo los presentados en sus sedes', async () => {
      expect(
        planIds(
          (await as(r).get('/treatment-plans/pending-follow-up').expect(200))
            .body,
        ),
      ).toEqual([followUpPlan.a1]);
      expect(
        planIds(
          (await as(r2).get('/treatment-plans/pending-follow-up').expect(200))
            .body,
        ),
      ).toEqual([followUpPlan.a2]);
    });
  });

  describe('recall (DX-015)', () => {
    const seedRecall = async (doc: string, locationId: string) => {
      const patientId = await createPatient(doc);
      const recall = await raw.patientRecall.create({
        data: {
          tenantId: a.tenantId,
          patientId,
          kind: 'CHECKUP',
          recallTypeId: (await seedDefaultRecallTypes(raw, a.tenantId)).CHECKUP,
          intervalMonths: 6,
          lastDoneAt: new Date('2020-01-15T00:00:00.000Z'),
          locationId,
          createdById: a.adminUserId,
          updatedById: a.adminUserId,
        },
        select: { id: true },
      });
      return { patientId, recallId: recall.id };
    };
    const contact = { channel: 'CALL', outcome: 'NO_ANSWER' };
    const contactsOf = (recallId: string) =>
      raw.recallContact.findMany({ where: { recallId } });
    const auditsOf = (patientId: string) =>
      raw.auditEvent.count({
        where: { patientId, resourceType: 'RECALL_CONTACT' },
      });

    it('la lista: sin cabecera solo sus sedes; otra sede explícita 403', async () => {
      const own = await seedRecall('RC-LIST-1', a1);
      const other = await seedRecall('RC-LIST-2', a2);
      const ids = async (m: Member) =>
        (
          (await as(m).get('/recall/due', { pageSize: 100 }).expect(200))
            .body as { items: { recallId: string }[] }
        ).items.map((i) => i.recallId);
      const mine = await ids(r);
      expect(mine).toContain(own.recallId);
      expect(mine).not.toContain(other.recallId);
      expect(await ids(r2)).toContain(other.recallId);
      expectNotAllowed(await as(r, a2).get('/recall/due'));
    });

    it('contacto en otra sede: 403 sin crear nada ni auditar, con y sin cabecera', async () => {
      const { patientId, recallId } = await seedRecall('RC-DENY', a2);
      expectNotAllowed(
        await as(r).post(`/recall/${recallId}/contacts`, contact),
      );
      expectNotAllowed(
        await as(r, a1).post(`/recall/${recallId}/contacts`, contact),
      );
      expect(await contactsOf(recallId)).toEqual([]);
      expect(await auditsOf(patientId)).toBe(0);
    });

    it('contacto en su sede: 201, sellado con la sede del recall aunque otra permitida esté activa', async () => {
      const own = await seedRecall('RC-OWN', a1);
      await as(r).post(`/recall/${own.recallId}/contacts`, contact).expect(201);
      const other = await seedRecall('RC-OWN-2', a2);
      await as(r2, a3)
        .post(`/recall/${other.recallId}/contacts`, contact)
        .expect(201);
      expect((await contactsOf(other.recallId))[0].locationId).toBe(a2);
    });

    it('manda la sede de la lista: fijado en A1 pero atendido en A2 es de A2', async () => {
      const { patientId, recallId } = await seedRecall('RC-MOVED', a1);
      const start = new Date('2021-03-10T15:00:00.000Z');
      await raw.appointment.create({
        data: {
          tenantId: a.tenantId,
          patientId,
          locationId: a2,
          providerId: e.userId,
          start,
          end: new Date(start.getTime() + 30 * 60_000),
          status: 'COMPLETED',
        },
      });
      expectNotAllowed(
        await as(r).post(`/recall/${recallId}/contacts`, contact),
      );
      await as(r2).post(`/recall/${recallId}/contacts`, contact).expect(201);
    });

    it('sin restricción, cualquier sede; un recall inexistente sigue siendo 404', async () => {
      const { recallId } = await seedRecall('RC-ALL', a2);
      await as(u).post(`/recall/${recallId}/contacts`, contact).expect(201);
      await as(r)
        .post('/recall/00000000-0000-4000-8000-000000000000/contacts', contact)
        .expect(404);
    });
  });

  describe('lo que NO se filtra', () => {
    it('pacientes y ficha: toda la clínica', async () => {
      await as(r).get('/patients').expect(200);
      await as(r).get(`/patients/${patient}`).expect(200);
    });
  });

  describe('DX-089-bis: autorización de escrituras por sede persistida', () => {
    const reason = 'Cobro duplicado por error';
    const seedPayment = (
      locationId: string,
      patientId = patient,
      treatmentPlanId = plan,
      createdById = r2.userId,
    ) =>
      raw.payment.create({
        data: {
          tenantId: a.tenantId,
          locationId,
          patientId,
          treatmentPlanId,
          amount: 73,
          currency: 'USD',
          paidAt: new Date(),
          createdById,
        },
      });
    const financialState = async () => ({
      payments: await raw.payment.findMany({
        where: { tenantId: a.tenantId },
        orderBy: { id: 'asc' },
      }),
      promises: await raw.paymentPromise.findMany({
        where: { tenantId: a.tenantId },
        orderBy: { id: 'asc' },
      }),
      allocations: await raw.paymentAllocation.findMany({
        where: { tenantId: a.tenantId },
        orderBy: { id: 'asc' },
      }),
      events: await raw.auditEvent.findMany({
        where: { tenantId: a.tenantId },
        orderBy: { id: 'asc' },
      }),
    });

    it('anular otra sede: 403 sin mutación, en vista consolidada o con cabecera permitida', async () => {
      const author = await seedUser(
        'void-author@dx089-restr-a.test',
        ClinicRole.RECEPTION,
      );
      const patientId = await createPatient('DX089-BIS-VOID');
      const treatmentPlan = await raw.treatmentPlan.create({
        data: { tenantId: a.tenantId, patientId, currency: 'USD' },
      });
      const promise = await raw.paymentPromise.create({
        data: {
          tenantId: a.tenantId,
          patientId,
          locationId: a1,
          amount: 73,
          currency: 'USD',
          dueDate: new Date('2027-01-15'),
          createdById: r2.userId,
        },
      });
      const payment = await seedPayment(
        a1,
        patientId,
        treatmentPlan.id,
        author.userId,
      );
      await restrict(author, [a2, a3]);
      tokens[author.email] = await loginAs(app, a.host, author.email);
      await raw.paymentPromise.update({
        where: { id: promise.id },
        data: { status: 'KEPT', settledAt: new Date() },
      });
      const before = await financialState();
      for (const active of [undefined, a2]) {
        expectNotAllowed(
          await as(author, active).delete(`/payments/${payment.id}`, {
            reason,
          }),
        );
        expect(await financialState()).toEqual(before);
      }
    });

    it('anula su propia sede aunque la cabecera señale otra sede permitida', async () => {
      const payment = await seedPayment(a3);
      await as(r2, a2)
        .delete(`/payments/${payment.id}`, { reason })
        .expect(200);
      const voided = await raw.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      expect(voided.deletedAt).not.toBeNull();
      expect(voided.voidedById).toBe(r2.userId);
    });

    it('ALL conserva acceso a abonos de cualquier sede', async () => {
      const payment = await seedPayment(a3);
      await admin().delete(`/payments/${payment.id}`, { reason }).expect(200);
      expect(
        (await raw.payment.findUniqueOrThrow({ where: { id: payment.id } }))
          .deletedAt,
      ).not.toBeNull();
    });

    it('loc vacío no puede anular ningún abono', async () => {
      const payment = await seedPayment(a2);
      const token = (
        await app.get(TokenService).issue({
          sub: r2.userId,
          tenantId: a.tenantId,
          role: ClinicRole.RECEPTION,
          loc: [],
          tv: 0,
        })
      ).accessToken;
      const before = await financialState();
      expectNotAllowed(
        await api(token).delete(`/payments/${payment.id}`, { reason }),
      );
      expect(await financialState()).toEqual(before);
    });

    it('abonos inexistentes o de otro tenant siguen siendo 404', async () => {
      const b = await registerClinic(app, 'dx089-bis-other');
      const location = await raw.location.findFirstOrThrow({
        where: { tenantId: b.tenantId },
      });
      const foreignPatient = await raw.patient.create({
        data: {
          tenantId: b.tenantId,
          firstName: 'Otro',
          lastName: 'Tenant',
          documentType: 'NATIONAL_ID',
          docNumber: 'BIS-OTHER',
          sex: Sex.F,
        },
      });
      const foreignPlan = await raw.treatmentPlan.create({
        data: {
          tenantId: b.tenantId,
          patientId: foreignPatient.id,
          currency: 'USD',
        },
      });
      const payment = await raw.payment.create({
        data: {
          tenantId: b.tenantId,
          locationId: location.id,
          patientId: foreignPatient.id,
          treatmentPlanId: foreignPlan.id,
          amount: 73,
          currency: 'USD',
          paidAt: new Date(),
        },
      });
      await as(r2).delete(`/payments/${payment.id}`, { reason }).expect(404);
      await as(r2)
        .delete('/payments/00000000-0000-4000-8000-000000000000', { reason })
        .expect(404);
      expect(
        (await raw.payment.findUniqueOrThrow({ where: { id: payment.id } }))
          .deletedAt,
      ).toBeNull();
    });

    it('nº de factura externa en otra sede: 403 sin mutación (DX-515)', async () => {
      const payment = await seedPayment(a1);
      const before = await financialState();
      for (const active of [undefined, a2]) {
        expectNotAllowed(
          await as(r2, active).put(
            `/payments/${payment.id}/external-invoice-number`,
            { externalInvoiceNumber: 'F-001' },
          ),
        );
        expect(await financialState()).toEqual(before);
      }
    });

    it('nº de factura externa en su sede aunque la cabecera señale otra permitida', async () => {
      const payment = await seedPayment(a3);
      await as(r2, a2)
        .put(`/payments/${payment.id}/external-invoice-number`, {
          externalInvoiceNumber: 'F-002',
        })
        .expect(200);
      expect(
        (await raw.payment.findUniqueOrThrow({ where: { id: payment.id } }))
          .externalInvoiceNumber,
      ).toBe('F-002');
    });

    // DX-525: leer, reimprimir y enviar el recibo, y cambiar la leyenda de una
    // sede, respetan las sedes permitidas como las escrituras de arriba.
    describe('recibo de caja y leyenda por sede (DX-525)', () => {
      const issueReceipt = async (locationId: string) =>
        (
          (
            await api(a.adminToken, locationId)
              .post(`/treatment-plans/${plan}/payments`, {
                amount: 10,
                currency: 'VES',
                paidAt: '2026-10-01',
              })
              .expect(201)
          ).body as { id: string }
        ).id;
      const receiptState = async () => ({
        outbox: await raw.emailOutbox.count({
          where: { tenantId: a.tenantId },
        }),
        events: await raw.auditEvent.count({
          where: { tenantId: a.tenantId, resourceType: 'PAYMENT_RECEIPT' },
        }),
      });
      const receiptRoutes = (id: string) =>
        [
          ['get', `/payments/${id}/receipt`],
          ['post', `/payments/${id}/receipt/print`],
          ['post', `/payments/${id}/receipt/email`],
        ] as const;
      const call = (
        m: Member,
        active: string | undefined,
        [verb, path]: readonly ['get' | 'post', string],
      ) =>
        verb === 'get' ? as(m, active).get(path) : as(m, active).post(path, {});

      beforeAll(async () => {
        await raw.patient.update({
          where: { id: patient },
          data: { email: 'dx525@example.com' },
        });
      });

      it('recibo emitido o «sin serie» de otra sede: 403 al ver, reimprimir y enviar, sin cambios', async () => {
        const issuedId = await issueReceipt(a1);
        const legacyId = (await seedPayment(a1)).id;
        const before = await receiptState();
        for (const id of [issuedId, legacyId]) {
          for (const route of receiptRoutes(id)) {
            // Vista consolidada y con una cabecera permitida: manda la sede
            // del abono, no la de la cabecera.
            for (const active of [undefined, a2]) {
              expectNotAllowed(await call(r2, active, route));
            }
          }
        }
        expect(await receiptState()).toEqual(before);
      });

      it('recibo de una sede ya retirada: el mismo 403 para quien no la tiene', async () => {
        const id = (await seedPayment(a3)).id;
        await raw.location.update({
          where: { id: a3 },
          data: { isActive: false },
        });
        try {
          for (const route of receiptRoutes(id)) {
            expectNotAllowed(await call(r, undefined, route));
          }
        } finally {
          await raw.location.update({
            where: { id: a3 },
            data: { isActive: true },
          });
        }
      });

      it('recibo de su sede: lo ve, lo reimprime y lo envía (y ADMIN, siempre)', async () => {
        const issuedId = await issueReceipt(a2);
        const legacyId = (await seedPayment(a2)).id;
        for (const id of [issuedId, legacyId]) {
          // R2 trabaja en A2 y A3: con o sin cabecera de su sede.
          for (const route of receiptRoutes(id)) {
            const ok = route[1].endsWith('/email') ? 202 : 200;
            await call(r2, undefined, route).expect(ok);
            await call(r2, a2, route).expect(ok);
            await (
              route[0] === 'get'
                ? admin().get(route[1])
                : admin().post(route[1], {})
            ).expect(ok);
          }
        }
      });

      it('leyenda de otra sede: 403 sin cambio, aun con un token ADMIN acotado', async () => {
        const token = (
          await app.get(TokenService).issue({
            sub: (
              await raw.clinicMembership.findFirstOrThrow({
                where: { tenantId: a.tenantId, role: ClinicRole.ADMIN },
              })
            ).userId,
            tenantId: a.tenantId,
            role: ClinicRole.ADMIN,
            loc: [a1],
            tv: 0,
          })
        ).accessToken;
        const legendOf = async (id: string) =>
          raw.location.findUniqueOrThrow({
            where: { id },
            select: { receiptLegendOverride: true, receiptLegend: true },
          });
        const before = await legendOf(a2);
        const events = await raw.auditEvent.count({
          where: { tenantId: a.tenantId },
        });
        expectNotAllowed(
          await api(token).put(`/payment-receipts/settings/locations/${a2}`, {
            override: true,
            legend: 'Otra sede',
          }),
        );
        expect(await legendOf(a2)).toEqual(before);
        expect(
          await raw.auditEvent.count({ where: { tenantId: a.tenantId } }),
        ).toBe(events);
        // Su propia sede sí; y el ADMIN sin restricción, cualquiera.
        await api(token)
          .put(`/payment-receipts/settings/locations/${a1}`, {
            override: true,
            legend: 'Mi sede',
          })
          .expect(200);
        await admin()
          .put(`/payment-receipts/settings/locations/${a2}`, {
            override: false,
          })
          .expect(200);
      });
    });

    it('movimientos en otra sede: 403 sin cambio en stock ni movimientos', async () => {
      const before = await raw.inventoryMovement.findMany({
        where: { itemId: item.a2 },
      });
      const beforeItem = await raw.inventoryItem.findUniqueOrThrow({
        where: { id: item.a2 },
      });
      const beforeStock = await admin()
        .get(`/inventory/items/${item.a2}`)
        .expect(200);
      for (const active of [undefined, a1]) {
        expectNotAllowed(
          await as(s, active).post(`/inventory/items/${item.a2}/movements`, {
            type: 'IN',
            quantity: 5,
          }),
        );
        expect(
          await raw.inventoryMovement.findMany({ where: { itemId: item.a2 } }),
        ).toEqual(before);
        expect(
          await raw.inventoryItem.findUniqueOrThrow({ where: { id: item.a2 } }),
        ).toEqual(beforeItem);
        const afterStock = await admin()
          .get(`/inventory/items/${item.a2}`)
          .expect(200);
        expect((afterStock.body as { stock: number }).stock).toBe(
          (beforeStock.body as { stock: number }).stock,
        );
      }
    });

    it('sella el movimiento con la sede del ítem aunque otra sede permitida esté activa', async () => {
      const member = await seedUser(
        'i1@dx089-restr-a.test',
        ClinicRole.ASSISTANT,
      );
      await restrict(member, [a1, a2]);
      const token = await loginAs(app, a.host, member.email);
      const target = await raw.inventoryItem.create({
        data: {
          tenantId: a.tenantId,
          locationId: a2,
          name: 'I1 sede B',
          unit: 'caja',
        },
      });
      const response = await api(token, a1)
        .post(`/inventory/items/${target.id}/movements`, {
          type: 'IN',
          quantity: 3,
        })
        .expect(201);
      const stored = await raw.inventoryMovement.findUniqueOrThrow({
        where: { id: (response.body as { id: string }).id },
      });
      expect(target.locationId).toBe(a2);
      expect(stored.tenantId).toBe(a.tenantId);
      expect(stored.itemId).toBe(target.id);
      expect(stored.locationId).toBe(a2);
      expect(stored.type).toBe('IN');
      expect(stored.quantity.toNumber()).toBe(3);
      const detail = await api(token, a2)
        .get(`/inventory/items/${target.id}`)
        .expect(200);
      expect((detail.body as { stock: number }).stock).toBe(3);
    });

    it('movimientos en sede propia y ALL conservan acceso', async () => {
      await as(s)
        .post(`/inventory/items/${item.a1}/movements`, {
          type: 'IN',
          quantity: 5,
        })
        .expect(201);
      const response = await admin()
        .post(`/inventory/items/${item.a2}/movements`, {
          type: 'IN',
          quantity: 7,
        })
        .expect(201);
      const stored = await raw.inventoryMovement.findUniqueOrThrow({
        where: { id: (response.body as { id: string }).id },
      });
      expect(stored.tenantId).toBe(a.tenantId);
      expect(stored.itemId).toBe(item.a2);
      expect(stored.locationId).toBe(a2);
      expect(stored.type).toBe('IN');
      expect(stored.quantity.toNumber()).toBe(7);
      expect(
        await raw.inventoryMovement.count({ where: { itemId: item.a1 } }),
      ).toBe(1);
      expect(
        await raw.inventoryMovement.count({ where: { itemId: item.a2 } }),
      ).toBe(1);
    });
  });

  describe('regresión: un miembro sin filas ve lo mismo que antes', () => {
    it('no tiene filas y sus listados coinciden con los del ADMIN', async () => {
      expect(
        await raw.membershipLocation.count({
          where: { tenantId: a.tenantId, membership: { userId: u.userId } },
        }),
      ).toBe(0);
      const pairs: [string, object][] = [
        ['/appointments', RANGE],
        ['/payments', PERIOD],
        ['/treatment-plans/pending-follow-up', {}],
        ['/waitlist', {}],
        ['/schedule-blocks', RANGE],
        ['/locations', {}],
      ];
      for (const [path, query] of pairs) {
        const mine = await as(u).get(path, query).expect(200);
        const theirs = await admin().get(path, query).expect(200);
        expect({ path, rows: rowsOf(mine.body) }).toEqual({
          path,
          rows: rowsOf(theirs.body),
        });
      }
      const appts = (await as(u).get('/appointments', RANGE).expect(200))
        .body as unknown[];
      expect(appts).toHaveLength(3);
    });

    it('sin cabecera escribe en la sede principal de la clínica', async () => {
      const res = await as(u)
        .post(`/treatment-plans/${plan}/payments`, {
          amount: 10,
          currency: 'USD',
          paidAt: '2026-10-01',
        })
        .expect(201);
      const row = await raw.payment.findUniqueOrThrow({
        where: { id: (res.body as { id: string }).id },
      });
      expect(row.locationId).toBe(a1);
    });
  });

  // SEC-014: la ficha (recetas, documentos, implantes, evoluciones) se LEE
  // desde toda la clínica, como el paciente; pero lo que se ESCRIBE sobre
  // una fila sellada con su sede sigue la regla de DX-089-bis (403 con code).
  describe('SEC-014: escrituras por id en la ficha de otra sede', () => {
    const t = () => ({ tenantId: a.tenantId });
    const hash = 'a'.repeat(64);
    const seedRx = (locationId: string) =>
      raw.prescription.create({
        data: {
          ...t(),
          locationId,
          patientId: patient,
          professionalId: d.userId,
          issuedAt: new Date('2026-10-20T14:00:00.000Z'),
          dispensationDate: new Date('2026-10-20T00:00:00.000Z'),
          validUntil: new Date('2026-11-19T00:00:00.000Z'),
          patientName: 'Paciente DX089-1',
          professionalName: 'Dr. D',
          professionalLicense: 'MPPS-1234',
          clinicName: 'Clínica A',
          locationName: 'Sede',
          singleFormat: true,
          printQuantityInWords: true,
          contentHash: hash,
        },
      });
    const seedImplant = (locationId: string) =>
      raw.patientImplant.create({
        data: {
          ...t(),
          locationId,
          patientId: patient,
          professionalId: d.userId,
          placedOn: new Date('2026-10-20T00:00:00.000Z'),
          toothNumber: '36',
          kind: 'IMPLANT',
          manufacturer: 'Fabricante',
          reference: 'REF-1',
          lot: 'LOT-1',
        },
      });
    const seedDocument = (locationId: string, n: number) =>
      raw.patientDocument.create({
        data: {
          ...t(),
          locationId,
          patientId: patient,
          category: 'REPORT',
          originalName: `informe-${n}.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: 10,
          sha256: String(n).repeat(64).slice(0, 64),
          storageKey: `patient-documents/${a.tenantId}/sec014-${n}.pdf`,
          uploadedById: d.userId,
        },
      });
    const seedEntry = (locationId: string) =>
      raw.clinicalEntry.create({
        data: {
          ...t(),
          locationId,
          patientId: patient,
          performedById: d.userId,
          entryDate: new Date('2026-10-20T14:00:00.000Z'),
          notes: 'Evolución SEC-014',
        },
      });
    const reason = { reason: 'Registrado en la sede equivocada' };
    const addendum = {
      reason: 'Dato de la pieza dental mal transcrito',
      text: 'Es la 36, no la 46.',
    };

    it('receta de otra sede: anular 403 sin cambio; verla, sí; en su sede, anula', async () => {
      const other = await seedRx(a2);
      for (const active of [undefined, a1]) {
        expectNotAllowed(
          await as(d, active).post(`/prescriptions/${other.id}/void`, reason),
        );
      }
      expect(
        await raw.prescription.findUniqueOrThrow({ where: { id: other.id } }),
      ).toMatchObject({ status: 'ISSUED', voidedAt: null });
      await as(d).get(`/prescriptions/${other.id}`).expect(200);
      const mine = await seedRx(a1);
      await as(d).post(`/prescriptions/${mine.id}/void`, reason).expect(200);
    });

    it('implante de otra sede: anular 403 sin cambio; en su sede, anula', async () => {
      const other = await seedImplant(a2);
      expectNotAllowed(await as(d).post(`/implants/${other.id}/void`, reason));
      expect(
        (
          await raw.patientImplant.findUniqueOrThrow({
            where: { id: other.id },
          })
        ).voidedAt,
      ).toBeNull();
      const mine = await seedImplant(a1);
      await as(d).post(`/implants/${mine.id}/void`, reason).expect(200);
    });

    it('documento de otra sede: anular 403 sin cambio; verlo, sí; en su sede, anula', async () => {
      const other = await seedDocument(a2, 1);
      expectNotAllowed(
        await as(d).post(
          `/patients/${patient}/documents/${other.id}/void`,
          reason,
        ),
      );
      expect(
        (
          await raw.patientDocument.findUniqueOrThrow({
            where: { id: other.id },
          })
        ).voidedAt,
      ).toBeNull();
      await as(d).get(`/patients/${patient}/documents/${other.id}`).expect(200);
      const mine = await seedDocument(a1, 2);
      await as(d)
        .post(`/patients/${patient}/documents/${mine.id}/void`, reason)
        .expect(200);
    });

    it('adenda a una evolución de otra sede: 403 sin escribir; leerlas, sí; en su sede, 201', async () => {
      const other = await seedEntry(a2);
      expectNotAllowed(
        await as(d).post(
          `/patients/${patient}/clinical-entries/${other.id}/addenda`,
          addendum,
        ),
      );
      expect(
        await raw.clinicalEntryAddendum.count({
          where: { clinicalEntryId: other.id },
        }),
      ).toBe(0);
      await as(d)
        .get(`/patients/${patient}/clinical-entries/${other.id}/addenda`)
        .expect(200);
      const mine = await seedEntry(a1);
      await as(d)
        .post(
          `/patients/${patient}/clinical-entries/${mine.id}/addenda`,
          addendum,
        )
        .expect(201);
    });
  });

  // SEC-014: una sede desactivada conserva su historial, pero no admite
  // escrituras nuevas con su cabecera (ni con el auto-pin de un token emitido
  // antes de desactivarla).
  describe('SEC-014: sede desactivada', () => {
    let a4: string;
    let z: Member;
    let zToken: string;
    let itemA4: string;
    // Precondiciones reales en A4 (antes de desactivarla): sin el arreglo,
    // las altas de abajo escribirían de verdad sobre ellas.
    let entryA4: string;
    let apptA4: string;

    function expectInactive(res: request.Response) {
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: LOCATION_INACTIVE_CODE,
        message: LOCATION_INACTIVE_MESSAGE,
        locationId: a4,
      });
    }

    beforeAll(async () => {
      a4 = (
        (
          await admin()
            .post(
              '/locations',
              locationBody(REGIONAL_CARACAS_FIXTURE, { name: 'Sede Oeste' }),
            )
            .expect(201)
        ).body as { id: string }
      ).id;
      itemA4 = (
        await raw.inventoryItem.create({
          data: {
            tenantId: a.tenantId,
            locationId: a4,
            name: 'Guantes Oeste',
            unit: 'caja',
          },
        })
      ).id;
      // Z trabaja solo en A4: su token lleva `loc = [A4]` (auto-pin).
      z = await seedUser('z@dx089-restr-a.test', ClinicRole.ASSISTANT);
      await restrict(z, [a4]);
      zToken = await loginAs(app, a.host, z.email);
      // Caja abierta en A4 (la salida de caja la usaría).
      await admin()
        .post('/cash-sessions/open', {
          locationId: a4,
          floats: [{ currency: 'USD', amount: 20 }],
        })
        .expect(201);
      // Sillones de A4 para reordenar (además del que nace con la sede).
      for (const name of ['Sillón Oeste 1', 'Sillón Oeste 2']) {
        await admin().post('/chairs', { locationId: a4, name }).expect(201);
      }
      entryA4 = (
        await raw.appointmentWaitlistEntry.create({
          data: { tenantId: a.tenantId, locationId: a4, patientId: patient },
        })
      ).id;
      apptA4 = (
        await raw.appointment.create({
          data: {
            tenantId: a.tenantId,
            locationId: a4,
            patientId: patient,
            providerId: e.userId,
            start: new Date('2027-03-18T15:00:00.000Z'),
            end: new Date('2027-03-18T15:30:00.000Z'),
          },
        })
      ).id;
      await admin().patch(`/locations/${a4}`, { isActive: false }).expect(200);
    });

    it('escribir con la cabecera de la sede desactivada → 400 en español, sin cambios', async () => {
      const items = await raw.inventoryItem.count({
        where: { tenantId: a.tenantId },
      });
      const movements = await raw.inventoryMovement.count({
        where: { tenantId: a.tenantId },
      });
      const before = await raw.patient.findUniqueOrThrow({
        where: { id: patient },
      });
      expectInactive(
        await api(a.adminToken, a4).post('/inventory/items', {
          name: 'Nuevo',
          unit: 'caja',
        }),
      );
      expectInactive(
        await api(a.adminToken, a4).post(
          `/inventory/items/${itemA4}/movements`,
          { type: 'IN', quantity: 2 },
        ),
      );
      expectInactive(
        await api(a.adminToken, a4).patch(`/patients/${patient}`, {
          firstName: 'Cambiado',
        }),
      );
      expect(
        await raw.inventoryItem.count({ where: { tenantId: a.tenantId } }),
      ).toBe(items);
      expect(
        await raw.inventoryMovement.count({ where: { tenantId: a.tenantId } }),
      ).toBe(movements);
      expect(
        await raw.patient.findUniqueOrThrow({ where: { id: patient } }),
      ).toEqual(before);
    });

    it('leer el historial de la sede desactivada sigue funcionando', async () => {
      const list = await api(a.adminToken, a4)
        .get('/inventory/items')
        .expect(200);
      expect(itemIds(list.body)).toContain(itemA4);
      await api(a.adminToken, a4).get(`/inventory/items/${itemA4}`).expect(200);
      await api(a.adminToken, a4).get('/payments', PERIOD).expect(200);
    });

    it('auto-pin en la sede desactivada (token anterior): escribir 400, leer 200', async () => {
      expectInactive(
        await api(zToken).post(`/inventory/items/${itemA4}/movements`, {
          type: 'IN',
          quantity: 1,
        }),
      );
      const list = await api(zToken).get('/inventory/items').expect(200);
      expect(itemIds(list.body)).toContain(itemA4);
    });

    // Altas que fijan la sede por el CUERPO (o por la fila de la que nacen):
    // sin cabecera, un ADMIN sin restricción. Una prueba por ruta, y cada una
    // con lo necesario para que SIN el arreglo se escribiera de verdad (caja
    // abierta, sillones y pendiente de A4 sembrados antes de desactivarla).
    // Cada prueba compara A4 entera y la auditoría antes y después.
    describe('altas con la sede desactivada en el cuerpo', () => {
      const SLOT = {
        slotStart: '2027-03-15T15:00:00.000Z',
        slotEnd: '2027-03-15T15:30:00.000Z',
      };
      let priceList: string;
      let agreement: string;
      let payerId: string;
      let before: unknown;

      const snapshotA4 = async () => {
        const inA4 = { tenantId: a.tenantId, locationId: a4 };
        const byId = { orderBy: { id: 'asc' as const } };
        return {
          cashSessions: await raw.cashSession.findMany({
            where: inA4,
            ...byId,
            select: { id: true, status: true },
          }),
          chairs: await raw.chair.findMany({
            where: inA4,
            ...byId,
            select: { id: true, name: true, sortOrder: true },
          }),
          blocks: await raw.scheduleBlock.count({ where: inA4 }),
          expenses: await raw.expense.count({ where: inA4 }),
          // Todos los estados: agendar cerraría la entrada (SCHEDULED).
          waitlist: await raw.appointmentWaitlistEntry.findMany({
            where: inA4,
            ...byId,
            select: { id: true, status: true },
          }),
          appointments: await raw.appointment.findMany({
            where: inA4,
            ...byId,
            select: { id: true, start: true, status: true },
          }),
          offers: await raw.waitlistOffer.count({ where: inA4 }),
          promises: await raw.paymentPromise.count({ where: inA4 }),
          priceLists: await raw.priceList.count({ where: inA4 }),
          agreements: await raw.agreement.count({ where: inA4 }),
          overrides: await raw.providerScheduleOverride.count({
            where: inA4,
          }),
          audits: await raw.auditEvent.count({
            where: { tenantId: a.tenantId },
          }),
        };
      };

      beforeAll(async () => {
        const t = { tenantId: a.tenantId };
        priceList = (
          await raw.priceList.create({
            data: { ...t, name: 'Tarifa SEC-014', currency: 'USD' },
          })
        ).id;
        payerId = (
          await raw.payer.create({
            data: { ...t, name: 'Aseguradora SEC-014', type: 'INSURER' },
          })
        ).id;
        agreement = (
          await raw.agreement.create({
            data: {
              ...t,
              name: 'Convenio SEC-014',
              payerId,
              kind: 'PERCENT_DISCOUNT',
              percent: 10,
            },
          })
        ).id;
      });

      beforeEach(async () => {
        before = await snapshotA4();
      });

      afterEach(async () => {
        expect(await snapshotA4()).toEqual(before);
      });

      it('abrir caja', async () => {
        expectInactive(
          await admin().post('/cash-sessions/open', {
            locationId: a4,
            floats: [{ currency: 'USD', amount: 20 }],
          }),
        );
      });

      it('crear sillón', async () => {
        expectInactive(
          await admin().post('/chairs', { locationId: a4, name: 'Sillón 9' }),
        );
      });

      it('reordenar los sillones reales de A4', async () => {
        expectInactive(
          await admin().put('/chairs/order', {
            locationId: a4,
            // Todos los de A4 (también el que nace con la sede), al revés.
            chairIds: (
              await raw.chair.findMany({
                where: { tenantId: a.tenantId, locationId: a4 },
                orderBy: { sortOrder: 'asc' },
                select: { id: true },
              })
            )
              .map((c) => c.id)
              .reverse(),
          }),
        );
      });

      it('crear bloqueo de agenda', async () => {
        expectInactive(
          await admin().post('/schedule-blocks', {
            locationId: a4,
            kind: 'MEETING',
            start: '2027-03-12T15:00:00.000Z',
            end: '2027-03-12T16:00:00.000Z',
          }),
        );
      });

      it('registrar gasto', async () => {
        expectInactive(
          await admin().post('/expenses', {
            locationId: a4,
            category: 'SUPPLIES',
            amount: 25,
            currency: 'USD',
            invoiceDate: '2026-10-20',
          }),
        );
      });

      it('salida de la caja abierta de A4', async () => {
        expectInactive(
          await admin().post('/cash-sessions/current/outflows', {
            locationId: a4,
            category: 'Mensajería',
            amount: 5,
            currency: 'USD',
          }),
        );
      });

      it('añadir a la lista de espera', async () => {
        expectInactive(
          await admin().post('/waitlist', {
            patientId: patient,
            locationId: a4,
          }),
        );
      });

      it('agendar desde la lista de espera una entrada de A4', async () => {
        expectInactive(
          await admin().post(`/waitlist/${entryA4}/schedule`, {
            providerId: e.userId,
            start: '2027-03-16T15:00:00.000Z',
          }),
        );
      });

      it('ofrecer un hueco de A4', async () => {
        expectInactive(
          await admin().post(`/appointments/openings/${a4}/offers`, {
            ...SLOT,
            providerId: e.userId,
            patientId: patient,
            channel: 'PHONE',
            outcome: 'NO_ANSWER',
          }),
        );
      });

      it('promesa de pago', async () => {
        expectInactive(
          await admin().post(`/patients/${patient}/payment-promises`, {
            locationId: a4,
            amount: 50,
            currency: 'USD',
            dueDate: '2026-11-30',
          }),
        );
      });

      it('crear y mover una tarifa', async () => {
        expectInactive(
          await admin().post('/price-lists', {
            name: 'Tarifa Oeste',
            currency: 'USD',
            locationId: a4,
          }),
        );
        expectInactive(
          await admin().patch(`/price-lists/${priceList}`, { locationId: a4 }),
        );
      });

      it('crear y mover un convenio', async () => {
        expectInactive(
          await admin().patch(`/agreements/${agreement}`, { locationId: a4 }),
        );
        expectInactive(
          await admin().post('/agreements', {
            name: 'Convenio Oeste',
            payerId,
            kind: 'PERCENT_DISCOUNT',
            percent: 5,
            locationId: a4,
          }),
        );
      });

      it('excepción de horario de un profesional que atiende en A4', async () => {
        expectInactive(
          await admin().post(`/providers/${e.userId}/schedule-overrides`, {
            locationId: a4,
            date: '2027-03-17',
            ranges: [],
          }),
        );
      });
    });

    // M1 de la revisión: reagendar una cita de A4 da 400 y no la mueve; pero
    // cancelarla sigue abierto, para poder cerrar la agenda de la sede.
    it('cita de A4: reagendar 400 sin moverla; cancelarla, 200', async () => {
      const start = (
        await raw.appointment.findUniqueOrThrow({ where: { id: apptA4 } })
      ).start;
      expectInactive(
        await admin().patch(`/appointments/${apptA4}`, {
          start: '2027-03-18T16:00:00.000Z',
          end: '2027-03-18T16:30:00.000Z',
        }),
      );
      expect(
        (await raw.appointment.findUniqueOrThrow({ where: { id: apptA4 } }))
          .start,
      ).toEqual(start);
      await admin()
        .patch(`/appointments/${apptA4}`, {
          status: 'CANCELLED',
          ...STAFF_CANCELLATION,
        })
        .expect(200);
      expect(
        (await raw.appointment.findUniqueOrThrow({ where: { id: apptA4 } }))
          .status,
      ).toBe('CANCELLED');
    });

    // B3 de la revisión: como con la cabecera, primero el 403 y luego el 400.
    // Un miembro acotado a A1 con A4 (ajena y desactivada) en el cuerpo
    // recibe el 403 de siempre, sin saber si está desactivada.
    it('miembro acotado a A1 con A4 en el cuerpo: 403 LOCATION_NOT_ALLOWED, no 400', async () => {
      const sessions = await raw.cashSession.count({
        where: { tenantId: a.tenantId },
      });
      expectNotAllowed(
        await as(r).post('/cash-sessions/open', {
          locationId: a4,
          floats: [{ currency: 'USD', amount: 20 }],
        }),
      );
      expect(
        await raw.cashSession.count({ where: { tenantId: a.tenantId } }),
      ).toBe(sessions);
    });

    it('una sede activa sigue admitiendo escrituras con su cabecera', async () => {
      await api(a.adminToken, a1)
        .post(`/inventory/items/${item.a1}/movements`, {
          type: 'IN',
          quantity: 1,
        })
        .expect(201);
    });
  });
});
