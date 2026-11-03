import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
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
import { civilDateIn } from '../src/shared/time/civil-day';
import { safeTodayZone, sedeTodayFixture } from './support/sede-clock';

// SEC-043-bis · En el detalle de un cierre a ciegas, el ADMIN ve cuántos
// recibos de abonos de esa caja abrió o imprimió quien la cerró entre la
// apertura y el cierre (el recibo lleva el importe que el ciego oculta). El
// recuento sale de la auditoría (VIEW y PRINT de PAYMENT_RECEIPT) y coincide
// con ella. Recepción no lo recibe. Importes en USD.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// DX-449: la API decide «hoy» con su reloj real y la zona de la sede.
const FIXTURE = sedeTodayFixture();
const ZONE = safeTodayZone();
const today = (): string => civilDateIn(new Date(), ZONE);

interface Closing {
  id: string;
  blind: boolean;
  closedAt: string;
  receiptViews: { receipts: number; views: number } | null;
}

interface Detail {
  id: string;
  openedAt: string;
  closing: Closing | null;
  closings: Closing[];
}

const idOf = (res: { body: unknown }): string =>
  (res.body as { id: string }).id;
const detailOf = (res: { body: unknown }): Detail => res.body as Detail;

describe('Recibos consultados antes de cerrar a ciegas (e2e, SEC-043-bis)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let otra: Clinic;
  let recepcion: string;
  let recepcionId: string;
  let planId: string;
  let caja: string;
  let primero: string;
  let segundo: string;
  let fuera: string;

  const api = (
    verb: 'get' | 'post' | 'put' | 'delete',
    path: string,
    token = clinic.adminToken,
    host = clinic.host,
  ) =>
    request(app.getHttpServer())
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', host)
      .set('Authorization', `Bearer ${token}`);
  const pay = (token: string, amount: number, method = 'CASH') =>
    api('post', `/treatment-plans/${planId}/payments`, token)
      .send({ currency: 'USD', paidAt: today(), amount, method })
      .expect(201);
  const viewReceipt = (id: string, token = recepcion) =>
    api('get', `/payments/${id}/receipt`, token).expect(200);
  const printReceipt = (id: string, token = recepcion) =>
    api('post', `/payments/${id}/receipt/print`, token).expect(200);
  const blind = (blindClose: boolean) =>
    api('put', '/cash-sessions/settings')
      .send({ requireOpenSession: false, blindClose })
      .expect(200);

  /** Lo que dice la auditoría, contado aparte (la verdad de referencia). */
  async function auditCount(
    sessionId: string,
    actorUserId: string,
    from: Date,
    to: Date,
  ): Promise<{ receipts: number; views: number }> {
    const payments = await raw.payment.findMany({
      where: { tenantId: clinic.tenantId, cashSessionId: sessionId },
      select: { id: true },
    });
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        actorUserId,
        resourceType: 'PAYMENT_RECEIPT',
        action: { in: ['VIEW', 'PRINT'] },
        occurredAt: { gte: from, lt: to },
        resourceId: { in: payments.map((p) => p.id) },
      },
      select: { resourceId: true },
    });
    return {
      receipts: new Set(events.map((e) => e.resourceId)).size,
      views: events.length,
    };
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'recibos-ciego', FIXTURE);
    otra = await registerClinic(app, 'recibos-otra', FIXTURE);
    const r = await seedMember(raw, clinic, ClinicRole.RECEPTION);
    recepcionId = r.userId;
    recepcion = await loginAs(app, clinic.host, r.email);
    const patient = await raw.patient.create({
      data: {
        tenantId: clinic.tenantId,
        firstName: 'Carmen',
        lastName: 'Recibos',
        docNumber: 'V-20345678',
      },
      select: { id: true },
    });
    planId = (
      await raw.treatmentPlan.create({
        data: {
          tenantId: clinic.tenantId,
          patientId: patient.id,
          currency: 'USD',
          status: 'ACCEPTED',
        },
        select: { id: true },
      })
    ).id;

    await blind(true);
    // Un abono fuera de toda caja (ADMIN sin caja): su recibo no cuenta.
    fuera = idOf(await pay(clinic.adminToken, 7, 'CARD'));
    caja = idOf(
      await api('post', '/cash-sessions/open', recepcion)
        .send({ floats: [{ currency: 'USD', amount: 100 }] })
        .expect(201),
    );
    primero = idOf(await pay(recepcion, 30));
    segundo = idOf(await pay(recepcion, 20));
    // Quien cuenta abre el recibo del primero dos veces, lo imprime una y abre
    // el del segundo: 2 recibos, 4 consultas. El de fuera no cuenta, ni lo que
    // consulte el ADMIN.
    await viewReceipt(primero);
    await viewReceipt(primero);
    await printReceipt(primero);
    await viewReceipt(segundo);
    await viewReceipt(fuera);
    await viewReceipt(primero, clinic.adminToken);
    await api('post', `/cash-sessions/${caja}/close`, recepcion)
      .send({ counts: [{ currency: 'USD', method: 'CASH', counted: 150 }] })
      .expect(201);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('ADMIN ve 2 recibos y 4 consultas, y coincide con la auditoría', async () => {
    const detail = detailOf(
      await api('get', `/cash-sessions/${caja}`).expect(200),
    );
    expect(detail.closing).toMatchObject({
      blind: true,
      receiptViews: { receipts: 2, views: 4 },
    });
    expect(detail.closings[0].receiptViews).toEqual({ receipts: 2, views: 4 });
    expect(
      await auditCount(
        caja,
        recepcionId,
        new Date(detail.openedAt),
        new Date(detail.closing!.closedAt),
      ),
    ).toEqual({ receipts: 2, views: 4 });
  });

  it('lo que se consulta después del cierre no cuenta', async () => {
    await viewReceipt(segundo);
    const detail = detailOf(
      await api('get', `/cash-sessions/${caja}`).expect(200),
    );
    expect(detail.closing?.receiptViews).toEqual({ receipts: 2, views: 4 });
  });

  it('recepción no lo recibe (null)', async () => {
    const own = detailOf(
      await api('get', `/cash-sessions/${caja}`, recepcion).expect(200),
    );
    expect(own.closing?.receiptViews).toBeNull();
  });

  it('otra clínica no ve la caja', async () => {
    await api(
      'get',
      `/cash-sessions/${caja}`,
      otra.adminToken,
      otra.host,
    ).expect(404);
  });

  it('sin consultas, 0 y 0 (la pantalla no dice nada); sin arqueo ciego, no se calcula (null)', async () => {
    const quiet = idOf(
      await api('post', '/cash-sessions/open', recepcion)
        .send({ floats: [] })
        .expect(201),
    );
    await api('post', `/cash-sessions/${quiet}/close`, recepcion)
      .send({ counts: [] })
      .expect(201);
    const quietDetail = detailOf(
      await api('get', `/cash-sessions/${quiet}`).expect(200),
    );
    expect(quietDetail.closing?.receiptViews).toEqual({
      receipts: 0,
      views: 0,
    });

    await blind(false);
    const plain = idOf(
      await api('post', '/cash-sessions/open', recepcion)
        .send({ floats: [] })
        .expect(201),
    );
    const p = idOf(await pay(recepcion, 9));
    await viewReceipt(p);
    await api('post', `/cash-sessions/${plain}/close`, recepcion)
      .send({ counts: [{ currency: 'USD', method: 'CASH', counted: 9 }] })
      .expect(201);
    const plainDetail = detailOf(
      await api('get', `/cash-sessions/${plain}`).expect(200),
    );
    expect(plainDetail.closing).toMatchObject({
      blind: false,
      receiptViews: null,
    });
  });
});
