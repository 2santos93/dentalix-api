import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient, Sex } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { PAYMENT_CLOCK } from '../src/modules/payments/application/use-cases/void-payment.use-case';
import { PAID_AT_IN_FUTURE_MESSAGE } from '../src/modules/payments/domain/paid-at-window';
import { DONE_ITEM_PRICE_LOCKED_MESSAGE } from '../src/modules/treatment-plans/domain/plan-status-machine';
import {
  type Clinic,
  createE2eApp,
  registerClinic,
  resetDatabase,
} from './support/e2e-fixtures';

// DX-054: invariantes del saldo y del plan que faltaban en main. Reloj de los
// abonos inyectado (PAYMENT_CLOCK): nada depende de la hora de la CI.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const PAYMENT_NOW = new Date('2026-10-31T15:00:00.000Z');

describe('DX-054: invariantes del saldo y del plan (e2e)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let planId: string;
  let doneItemId: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`);

  beforeAll(async () => {
    app = await createE2eApp((builder) => {
      builder.overrideProvider(PAYMENT_CLOCK).useValue(() => PAYMENT_NOW);
    });
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx054');

    const patient = await as(api().post('/api/v1/patients'))
      .send({
        firstName: 'Saldo',
        lastName: 'Único',
        docType: 'NATIONAL_ID',
        docNumber: 'DX054-001',
        sex: Sex.F,
      })
      .expect(201);
    const catalog = await as(api().post('/api/v1/catalog/items'))
      .send({
        code: 'DX054-RES',
        kind: 'PROCEDURE',
        labelEs: 'Resina',
        color: '#2A2B3C',
        defaultPrice: 100,
      })
      .expect(201);
    const plan = await as(
      api().post(
        `/api/v1/patients/${(patient.body as { id: string }).id}/treatment-plans`,
      ),
    )
      .send({ currency: 'USD' })
      .expect(201);
    planId = (plan.body as { id: string }).id;
    const item = await as(api().post(`/api/v1/treatment-plans/${planId}/items`))
      .send({
        toothNumber: '11',
        catalogItemId: (catalog.body as { id: string }).id,
      })
      .expect(201);
    doneItemId = (item.body as { id: string }).id;
    await as(
      api().patch(`/api/v1/treatment-plans/${planId}/items/${doneItemId}`),
    )
      .send({ status: 'DONE' })
      .expect(200);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('cambiar el precio de un ítem realizado → 409 en español; repetirlo o cambiar notas, 200', async () => {
    const res = await as(
      api().patch(`/api/v1/treatment-plans/${planId}/items/${doneItemId}`),
    )
      .send({ price: 80 })
      .expect(409);
    expect((res.body as { message: string }).message).toBe(
      DONE_ITEM_PRICE_LOCKED_MESSAGE,
    );
    await as(
      api().patch(`/api/v1/treatment-plans/${planId}/items/${doneItemId}`),
    )
      .send({ price: 100, notes: 'Sin cambios de precio' })
      .expect(200);
    const balance = await as(
      api().get(`/api/v1/treatment-plans/${planId}/balance`),
    ).expect(200);
    expect((balance.body as { billable: number }).billable).toBe(100);
  });

  it('un abono con fecha a más de 24 h en el futuro → 400 en español y no se registra', async () => {
    for (const paidAt of ['2026-11-03', '2026-11-01T15:00:01.000Z']) {
      const res = await as(
        api().post(`/api/v1/treatment-plans/${planId}/payments`),
      )
        .send({ amount: 10, currency: 'USD', paidAt, method: 'CASH' })
        .expect(400);
      expect((res.body as { message: string }).message).toBe(
        PAID_AT_IN_FUTURE_MESSAGE,
      );
    }
    const balance = await as(
      api().get(`/api/v1/treatment-plans/${planId}/balance`),
    ).expect(200);
    expect(balance.body).toMatchObject({
      paid: 0,
      paymentsCount: 0,
      rateProviderTimedOut: false,
    });
  });

  it('dentro de las 24 h (mañana en otra zona) se registra', async () => {
    await as(api().post(`/api/v1/treatment-plans/${planId}/payments`))
      .send({
        amount: 10,
        currency: 'USD',
        paidAt: '2026-11-01',
        method: 'CASH',
      })
      .expect(201);
    const balance = await as(
      api().get(`/api/v1/treatment-plans/${planId}/balance`),
    ).expect(200);
    expect(balance.body).toMatchObject({
      billable: 100,
      paid: 10,
      balance: 90,
    });
  });
});
