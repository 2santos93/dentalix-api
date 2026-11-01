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
} from './support/e2e-fixtures';
import { TokenService } from '../src/shared/crypto/token.service';
import { PasswordService } from '../src/shared/crypto/password.service';
import {
  LOCATION_NOT_ALLOWED_CODE,
  LOCATION_NOT_ALLOWED_MESSAGE,
} from '../src/shared/tenancy/location-access';
import { PROVIDER_NOT_AT_LOCATION_MESSAGE } from '../src/modules/staff/domain/provider-location';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationBody,
} from './support/location-fixtures';

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
            .post('/locations', locationBody(REGIONAL_BOGOTA_FIXTURE, { name }))
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
        data: { ...t, patientId: patient, currency: 'COP', status: 'ACCEPTED' },
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
          currency: 'COP',
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
            currency: 'COP',
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
                currency: 'COP',
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
          currency: 'COP',
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
          currency: 'COP',
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
        data: { tenantId: a.tenantId, patientId, currency: 'COP' },
      });
      const promise = await raw.paymentPromise.create({
        data: {
          tenantId: a.tenantId,
          patientId,
          locationId: a1,
          amount: 73,
          currency: 'COP',
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
          currency: 'COP',
        },
      });
      const payment = await raw.payment.create({
        data: {
          tenantId: b.tenantId,
          locationId: location.id,
          patientId: foreignPatient.id,
          treatmentPlanId: foreignPlan.id,
          amount: 73,
          currency: 'COP',
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
          currency: 'COP',
          paidAt: '2026-10-01',
        })
        .expect(201);
      const row = await raw.payment.findUniqueOrThrow({
        where: { id: (res.body as { id: string }).id },
      });
      expect(row.locationId).toBe(a1);
    });
  });
});
