import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient, Sex } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { CLOCK } from '../src/modules/payment-plans/application/use-cases/get-payment-plan.use-case';
import { ACCOUNT_STATEMENT_CLOCK } from '../src/modules/account-statement/application/use-cases/get-account-statement.use-case';
import { RECEIVABLES_CLOCK } from '../src/modules/receivables/application/use-cases/get-receivables-aging.use-case';
import { COLLECTIONS_CLOCK } from '../src/modules/collections/application/collections-clock';
import { PAYMENT_CLOCK } from '../src/modules/payments/application/use-cases/void-payment.use-case';
import { PAID_AT_AFTER_SITE_TODAY_MESSAGE } from '../src/modules/payments/domain/paid-at-window';
import {
  type Clinic,
  createE2eApp,
  registerClinic,
  resetDatabase,
} from './support/e2e-fixtures';
import { pinCatalogCurrency } from './support/catalog-currency';

// DX-110: una cuota vence según el día civil de la sede del plan (Caracas,
// UTC−4), no el día UTC; y un abono no puede caer en un día posterior a hoy
// en la sede, ni como día ni como instante. Un solo reloj para todos los
// módulos, que cada prueba mueve.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// La cuota 1 vence el 10 de noviembre (día civil).
const DUE_DAY = '2026-11-10';
// 21:00 del 10 en Caracas = 01:00Z del 11: en UTC ya es el 11.
const CARACAS_10_AT_2100 = new Date('2026-11-11T01:00:00.000Z');
// 00:30 del 11 en Caracas = 04:30Z del 11.
const CARACAS_11_AT_0030 = new Date('2026-11-11T04:30:00.000Z');

let now = CARACAS_10_AT_2100;
const clock = () => now;

interface PaymentPlanBody {
  installments: { sequence: number; dueDate: string; status: string }[];
  overdueCount: number;
  overdueAmount: number;
  nextDue: { sequence: number | null; dueDate: string } | null;
}

interface StatementBody {
  summary: { currency: string; overdueCount: number; overdueAmount: number }[];
  installments: { sequence: number | null; status: string }[];
}

interface AgingBody {
  items: { patient: { id: string }; oldestAgeDays: number | null }[];
}

describe('DX-110: cuotas vencidas y abonos por el día civil de la sede (e2e)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let patientId: string;
  let planId: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`);

  const paymentPlan = async () =>
    (
      await as(
        api().get(`/api/v1/treatment-plans/${planId}/payment-plan`),
      ).expect(200)
    ).body as PaymentPlanBody;
  const statement = async () =>
    (
      await as(
        api().get(`/api/v1/patients/${patientId}/account-statement`),
      ).expect(200)
    ).body as StatementBody;
  const agingRow = async () =>
    (
      (
        await as(api().get('/api/v1/receivables/aging?pageSize=100')).expect(
          200,
        )
      ).body as AgingBody
    ).items.find((r) => r.patient.id === patientId);

  beforeAll(async () => {
    app = await createE2eApp((builder) => {
      builder
        .overrideProvider(CLOCK)
        .useValue(clock)
        .overrideProvider(ACCOUNT_STATEMENT_CLOCK)
        .useValue(clock)
        .overrideProvider(RECEIVABLES_CLOCK)
        .useValue(clock)
        .overrideProvider(COLLECTIONS_CLOCK)
        .useValue(clock)
        .overrideProvider(PAYMENT_CLOCK)
        .useValue(clock);
    });
    await resetDatabase(raw);
    // La sede principal en America/Caracas (fixture regional por defecto).
    clinic = await registerClinic(app, 'dx110');

    const patient = await as(api().post('/api/v1/patients'))
      .send({
        firstName: 'Cuota',
        lastName: 'Caraqueña',
        docType: 'NATIONAL_ID',
        docNumber: 'DX110-001',
        sex: Sex.F,
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;
    await pinCatalogCurrency(raw, clinic.tenantId, 'USD');
    const catalog = await as(api().post('/api/v1/catalog/items'))
      .send({
        code: 'DX110-RES',
        kind: 'PROCEDURE',
        labelEs: 'Resina',
        color: '#2A2B3C',
        defaultPrice: 100,
      })
      .expect(201);
    const plan = await as(
      api().post(`/api/v1/patients/${patientId}/treatment-plans`),
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
    await as(
      api().patch(
        `/api/v1/treatment-plans/${planId}/items/${(item.body as { id: string }).id}`,
      ),
    )
      .send({ status: 'ACCEPTED' })
      .expect(200);
    await as(api().patch(`/api/v1/treatment-plans/${planId}`))
      .send({ status: 'ACCEPTED' })
      .expect(200);
    // Dos cuotas de 50 USD: el 10 de noviembre y el 10 de diciembre.
    await as(api().post(`/api/v1/treatment-plans/${planId}/payment-plan`))
      .send({
        installmentsCount: 2,
        periodicity: 'MONTHLY',
        startDate: DUE_DAY,
      })
      .expect(201);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('a las 21:00 del día de vencimiento en Caracas (01:00Z del día siguiente) la cuota NO está vencida', async () => {
    now = CARACAS_10_AT_2100;

    const pp = await paymentPlan();
    expect(pp.installments[0]).toMatchObject({
      sequence: 1,
      status: 'PENDING',
    });
    expect(pp.overdueCount).toBe(0);
    expect(pp.nextDue).toMatchObject({ sequence: 1 });

    const st = await statement();
    expect(st.installments[0]).toMatchObject({
      sequence: 1,
      status: 'PENDING',
    });
    expect(st.summary.find((s) => s.currency === 'USD')).toMatchObject({
      overdueCount: 0,
      overdueAmount: 0,
    });

    expect(await agingRow()).toMatchObject({ oldestAgeDays: null });
  });

  it('a las 00:30 del día siguiente en Caracas la cuota está vencida en el plan, el estado de cuenta y la cartera', async () => {
    now = CARACAS_11_AT_0030;

    const pp = await paymentPlan();
    expect(pp.installments[0]).toMatchObject({
      sequence: 1,
      status: 'OVERDUE',
    });
    expect(pp.overdueCount).toBe(1);
    expect(pp.overdueAmount).toBe(50);

    const st = await statement();
    expect(st.installments[0]).toMatchObject({
      sequence: 1,
      status: 'OVERDUE',
    });
    expect(st.summary.find((s) => s.currency === 'USD')).toMatchObject({
      overdueCount: 1,
      overdueAmount: 50,
    });

    expect(await agingRow()).toMatchObject({ oldestAgeDays: 1 });
  });

  it('un abono con fecha de mañana en Caracas → 400 en español, como día y como instante', async () => {
    now = CARACAS_10_AT_2100;
    for (const paidAt of [
      '2026-11-11',
      // 10:00 del 11 en Caracas: dentro de las 24 h, pero mañana en la sede.
      '2026-11-11T14:00:00.000Z',
    ]) {
      const res = await as(
        api().post(`/api/v1/treatment-plans/${planId}/payments`),
      )
        .send({ amount: 10, currency: 'USD', paidAt, method: 'CASH' })
        .expect(400);
      expect((res.body as { message: string }).message).toBe(
        PAID_AT_AFTER_SITE_TODAY_MESSAGE,
      );
    }
  });

  it('un abono de hoy a las 23:00 en Caracas se registra aunque en UTC ya sea mañana', async () => {
    now = CARACAS_10_AT_2100;
    // 23:00 del 10 en Caracas = 03:00Z del 11.
    await as(api().post(`/api/v1/treatment-plans/${planId}/payments`))
      .send({
        amount: 10,
        currency: 'USD',
        paidAt: '2026-11-11T03:00:00.000Z',
        method: 'CASH',
      })
      .expect(201);
  });
});
