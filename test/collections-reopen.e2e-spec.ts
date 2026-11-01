import { INestApplication } from '@nestjs/common';
import {
  CatalogKind,
  ClinicRole,
  Prisma,
  PrismaClient,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  addCivilDays,
  civilDateIn,
  zonedStartOfDay,
} from '../src/shared/time/civil-day';
import { sedeTodayFixture } from './support/sede-clock';
import { PAYMENT_CLOCK } from '../src/modules/payments/application/use-cases/void-payment.use-case';

// DX-215 (BE-032) · abono → compromiso CUMPLIDO → anulación del abono →
// ABIERTO (antes de la fecha) o INCUMPLIDO (después, en la zona de la sede);
// sigue CUMPLIDO si otro abono vigente lo cubre. La cartera y la ficha lo
// reflejan y la reapertura queda auditada sin importes ni textos. Solo
// ADMIN/RECEPTION anulan; otra clínica no ve el abono. El reloj de la
// anulación (PAYMENT_CLOCK) se mueve para el caso «después de la fecha».
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// DX-495 (TST-062): la clínica usa la zona segura de DX-449 (Bogotá lejos de
// su medianoche; si no, una zona en la que ahora es cerca del mediodía): el
// «hoy» de los abonos y el de la API no se separan si la corrida cruza la
// medianoche de Bogotá.
const SEDE = sedeTodayFixture();
const today = (): string => civilDateIn(new Date(), SEDE.timeZone);

interface PromiseBody {
  id: string;
  status: string;
  covered: number;
  reopenedAt: string | null;
}

describe('Cobranza — un compromiso cumplido se reabre al anular su abono (e2e, DX-215)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let catalogItemId: string;
  let receptionToken: string;
  let dentistToken: string;
  /** Lo que devuelve PAYMENT_CLOCK; `null` = el reloj real. */
  let voidClock: Date | null = null;

  const server = () => app.getHttpServer();
  const api = (
    clinic: Clinic,
    verb: 'get' | 'post' | 'delete',
    path: string,
    token = clinic.adminToken,
  ) =>
    request(server())
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);

  async function debtor(doc: string) {
    const patient = await raw.patient.create({
      data: {
        tenantId: clinicA.tenantId,
        firstName: 'Reabre',
        lastName: doc,
        docNumber: doc,
      },
      select: { id: true },
    });
    const plan = await raw.treatmentPlan.create({
      data: {
        tenantId: clinicA.tenantId,
        patientId: patient.id,
        currency: 'COP',
        status: TreatmentPlanStatus.ACCEPTED,
        items: {
          create: {
            toothNumber: '11',
            catalogItemId,
            price: 900_000,
            status: TreatmentPlanItemStatus.ACCEPTED,
          },
        },
      },
      select: { id: true },
    });
    return { patientId: patient.id, planId: plan.id };
  }

  async function promise(patientId: string, dueDate: string): Promise<string> {
    const res = await api(
      clinicA,
      'post',
      `/patients/${patientId}/payment-promises`,
      receptionToken,
    )
      .send({ amount: 200000, currency: 'COP', dueDate })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function pay(planId: string, amount = 200000): Promise<string> {
    const res = await api(
      clinicA,
      'post',
      `/treatment-plans/${planId}/payments`,
      receptionToken,
    )
      .send({
        amount,
        currency: 'COP',
        paidAt: new Date().toISOString(),
        method: 'CASH',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  function voidPayment(paymentId: string, token = receptionToken) {
    return api(clinicA, 'delete', `/payments/${paymentId}`, token).send({
      reason: 'Cobro duplicado por error',
    });
  }

  async function promiseOf(patientId: string): Promise<PromiseBody> {
    const res = await api(
      clinicA,
      'get',
      `/patients/${patientId}/collections`,
      receptionToken,
    ).expect(200);
    return (res.body as { promises: PromiseBody[] }).promises[0];
  }

  async function agingPromise(patientId: string, query = '') {
    const res = await api(
      clinicA,
      'get',
      `/receivables/aging${query}`,
      receptionToken,
    ).expect(200);
    const rows = (
      res.body as {
        items: {
          patient: { id: string };
          promise: { status: string; reopenedAt: string | null } | null;
        }[];
      }
    ).items;
    return rows.find((r) => r.patient.id === patientId)?.promise ?? null;
  }

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) =>
        builder
          .overrideProvider(PAYMENT_CLOCK)
          .useValue(() => voidClock ?? new Date()),
    });
    await resetDatabase(raw);
    clinicA = await registerClinic(app, 'reabre-a', SEDE);
    clinicB = await registerClinic(app, 'reabre-b', SEDE);
    const catalog = await api(clinicA, 'post', '/catalog/items')
      .send({
        code: 'REABRE',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Corona',
        color: '#2A2B3C',
        defaultPrice: 1,
      })
      .expect(201);
    catalogItemId = (catalog.body as { id: string }).id;
    for (const role of [ClinicRole.RECEPTION, ClinicRole.DENTIST]) {
      const { email } = await seedMember(raw, clinicA, role);
      const token = await loginAs(app, clinicA.host, email);
      if (role === ClinicRole.RECEPTION) receptionToken = token;
      else dentistToken = token;
    }
  });

  afterEach(() => {
    voidClock = null;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('abono → CUMPLIDO → anulación antes de la fecha → ABIERTO, en la ficha y en la cartera, auditado sin importes', async () => {
    const d = await debtor('DX215-1');
    const dueDate = addCivilDays(today(), 7);
    const promiseId = await promise(d.patientId, dueDate);
    const paymentId = await pay(d.planId);
    expect(await promiseOf(d.patientId)).toMatchObject({
      id: promiseId,
      status: 'KEPT',
      covered: 200000,
      reopenedAt: null,
    });
    expect(await agingPromise(d.patientId, '?hasPromise=true')).toBeNull();

    await voidPayment(paymentId).expect(200);

    const reopened = await promiseOf(d.patientId);
    expect(reopened).toMatchObject({
      id: promiseId,
      status: 'OPEN',
      covered: 0,
    });
    expect(reopened.reopenedAt).not.toBeNull();
    // Vuelve a ser «con compromiso» en la cartera.
    expect(await agingPromise(d.patientId, '?hasPromise=true')).toMatchObject({
      status: 'OPEN',
      reopenedAt: reopened.reopenedAt,
    });

    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinicA.tenantId,
        resourceType: 'PAYMENT_PROMISE',
        resourceId: promiseId,
        action: 'UPDATE',
      },
      orderBy: { occurredAt: 'asc' },
      select: { actorRole: true, patientId: true, metadata: true },
    });
    expect(events).toEqual([
      {
        actorRole: 'RECEPTION',
        patientId: d.patientId,
        metadata: { reason: 'PROMISE_KEPT' },
      },
      {
        actorRole: 'RECEPTION',
        patientId: d.patientId,
        metadata: {
          reason: 'PAYMENT_VOIDED',
          params: { paymentId },
          statusChange: { from: 'KEPT', to: 'OPEN' },
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/200000|Cobro duplicado/);

    // Un abono nuevo lo vuelve a cumplir.
    await pay(d.planId);
    expect((await promiseOf(d.patientId)).status).toBe('KEPT');
  });

  it('anulación después de la fecha (zona de la sede) → INCUMPLIDO', async () => {
    const d = await debtor('DX215-2');
    const dueDate = addCivilDays(today(), 1);
    const promiseId = await promise(d.patientId, dueDate);
    const paymentId = await pay(d.planId);
    expect((await promiseOf(d.patientId)).status).toBe('KEPT');

    // 00:30 del día siguiente a la fecha en la sede; solo ADMIN anula abonos
    // de otro día.
    voidClock = new Date(
      zonedStartOfDay(addCivilDays(dueDate, 1), SEDE.timeZone).getTime() +
        30 * 60_000,
    );
    await voidPayment(paymentId).expect(403);
    await voidPayment(paymentId, clinicA.adminToken).expect(200);

    expect(await promiseOf(d.patientId)).toMatchObject({
      id: promiseId,
      status: 'BROKEN',
      covered: 0,
    });
    expect(await agingPromise(d.patientId)).toMatchObject({
      status: 'BROKEN',
    });
    const event = await raw.auditEvent.findFirstOrThrow({
      where: {
        tenantId: clinicA.tenantId,
        resourceId: promiseId,
        metadata: { path: ['reason'], equals: 'PAYMENT_VOIDED' },
      },
      select: { actorRole: true, metadata: true },
    });
    expect(event).toEqual({
      actorRole: 'ADMIN',
      metadata: {
        reason: 'PAYMENT_VOIDED',
        params: { paymentId },
        statusChange: { from: 'KEPT', to: 'BROKEN' },
      },
    });
  });

  it('si otro abono vigente sigue cubriendo el importe, sigue CUMPLIDO', async () => {
    const d = await debtor('DX215-3');
    const promiseId = await promise(d.patientId, addCivilDays(today(), 7));
    const first = await pay(d.planId);
    await pay(d.planId);

    await voidPayment(first).expect(200);

    expect(await promiseOf(d.patientId)).toMatchObject({
      id: promiseId,
      status: 'KEPT',
      covered: 200000,
      reopenedAt: null,
    });
  });

  it('solo ADMIN/RECEPTION anulan; otra clínica no ve el abono; el compromiso no cambia', async () => {
    const d = await debtor('DX215-4');
    await promise(d.patientId, addCivilDays(today(), 7));
    const paymentId = await pay(d.planId);

    await voidPayment(paymentId, dentistToken).expect(403);
    await api(clinicB, 'delete', `/payments/${paymentId}`)
      .send({ reason: 'Cobro duplicado por error' })
      .expect(404);

    expect((await promiseOf(d.patientId)).status).toBe('KEPT');
  });
});
