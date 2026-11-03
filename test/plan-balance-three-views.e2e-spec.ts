import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient, Sex } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { ConfigService } from '@nestjs/config';
import { EXCHANGE_RATE_PROVIDER } from '../src/modules/exchange/domain/ports/exchange-rate-provider.port';
import {
  OpenExchangeRatesProvider,
  PROVIDER_TIMEOUT_MS,
} from '../src/modules/exchange/infrastructure/providers/open-exchange-rates.provider';
import { NOT_RESPONDING_NEGATIVE_TTL_MS } from '../src/modules/exchange/application/provider-rates-gate';
import { BALANCE_CONVERSION_BUDGET_MS } from '../src/modules/payments/application/conversion-deadline';
import { EXCHANGE_RATE_CLOCK } from '../src/modules/exchange/application/use-cases/manual-exchange-rates.use-cases';
import { createE2eApp } from './support/create-e2e-app';
import { fixedSedeDay } from './support/sede-clock';
import {
  registerClinic,
  resetDatabase,
  type Clinic,
} from './support/e2e-fixtures';
import { REGIONAL_NEW_YORK_FIXTURE } from './support/location-fixtures';

// DX-472: `/balance`, el estado de cuenta y `/payment-plan` dan las mismas
// cifras por plan, con un plan USD con abonos en JPY, uno JPY (sin decimales),
// uno CANCELLED con abonos e ítems PROPOSED. El proveedor de tasas es el de
// verdad (OpenExchangeRatesProvider) contra un servidor HTTP de prueba que
// responde o se queda colgado sin contestar nunca. `raw` (DIRECT_URL) deja un
// plan como lo dejó el pasado: cancelado con abonos y abonos sin tasa congelada.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const RATES = { JPY: 150, VES: 36 };
const TOO_SLOW_MS = 6_000;

interface Figures {
  billable: number;
  paid: number;
  balance: number;
  paymentsWithoutRate: { paymentId: string }[];
  rateProviderTimedOut: boolean;
}
interface Installment {
  status: string;
  covered: number;
}
interface PaymentPlanBody extends Figures {
  paidTotal: number;
  overdueCount: number;
  overdueAmount: number;
  installments: Installment[];
}
interface StatementBody {
  rateProviderTimedOut: boolean;
  plans: (Figures & { id: string; budgeted: number })[];
  summary: {
    currency: string;
    paid: number;
    convertedPaid: number;
    convertedBalance: number;
    overdueCount: number;
  }[];
  installments: (Installment & { treatmentPlanId: string })[];
}

describe('DX-472: mismas cifras en /balance, estado de cuenta y plan de pagos (e2e)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let patientId: string;
  let catalogItemId: string;
  let provider: Server;
  let hanging = false;
  const open = new Set<ServerResponse>();
  const sockets = new Set<Socket>();
  let clockOffsetMs = 0;

  const usd = { id: '', paymentPlan: true };
  const jpy = { id: '', paymentPlan: true };
  const cancelled = { id: '', paymentPlan: true };

  const paidOn = fixedSedeDay(3).day;
  const legacyOn = fixedSedeDay(4).day;
  const start = fixedSedeDay(70).day;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`);

  async function planWith(
    currency: string,
    accepted: number,
    proposed: number | null,
  ): Promise<string> {
    const plan = await as(
      api().post(`/api/v1/patients/${patientId}/treatment-plans`),
    )
      .send({ currency })
      .expect(201);
    const id = (plan.body as { id: string }).id;
    const addItem = (price: number) =>
      as(api().post(`/api/v1/treatment-plans/${id}/items`))
        .send({ toothNumber: '11', catalogItemId, price })
        .expect(201)
        .then((res) => (res.body as { id: string }).id);
    const itemId = await addItem(accepted);
    await as(api().patch(`/api/v1/treatment-plans/${id}/items/${itemId}`))
      .send({ status: 'ACCEPTED' })
      .expect(200);
    if (proposed !== null) await addItem(proposed);
    return id;
  }

  const pay = (
    planId: string,
    amount: number,
    currency: string,
    day: string = paidOn,
  ) =>
    as(api().post(`/api/v1/treatment-plans/${planId}/payments`))
      .send({ amount, currency, paidAt: day, method: 'CASH' })
      .expect(201)
      .then((res) => (res.body as { id: string }).id);

  const finance = (planId: string, totalToFinance: number) =>
    as(api().post(`/api/v1/treatment-plans/${planId}/payment-plan`))
      .send({
        totalToFinance,
        installmentsCount: 2,
        periodicity: 'MONTHLY',
        startDate: start,
      })
      .expect(201);

  const views = async (planId: string) => {
    const started = Date.now();
    const [balance, statement, paymentPlan] = await Promise.all([
      as(api().get(`/api/v1/treatment-plans/${planId}/balance`)),
      as(api().get(`/api/v1/patients/${patientId}/account-statement`)),
      as(api().get(`/api/v1/treatment-plans/${planId}/payment-plan`)),
    ]);
    return {
      elapsedMs: Date.now() - started,
      statuses: [balance.status, statement.status, paymentPlan.status],
      balance: balance.body as Figures,
      statement: statement.body as StatementBody,
      paymentPlan: paymentPlan.body as PaymentPlanBody,
    };
  };

  const picked = ({
    billable,
    paid,
    balance,
    rateProviderTimedOut,
    paymentsWithoutRate,
  }: Figures) => ({
    billable,
    paid,
    balance,
    rateProviderTimedOut,
    paymentsWithoutRate,
  });

  async function expectSameFigures(planId: string, expected: object) {
    const { statuses, balance, statement, paymentPlan } = await views(planId);
    expect(statuses).toEqual([200, 200, 200]);
    const line = statement.plans.find((p) => p.id === planId);
    expect(picked(balance)).toMatchObject(expected);
    expect(picked(line as Figures)).toEqual(picked(balance));
    expect(picked(paymentPlan)).toEqual(picked(balance));
  }

  beforeAll(async () => {
    provider = createServer((_req, res) => {
      if (hanging) {
        open.add(res);
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ base: 'USD', rates: RATES }));
    });
    provider.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, '127.0.0.1', resolve),
    );
    const { port } = provider.address() as AddressInfo;
    const settings: Record<string, string> = {
      EXCHANGE_APP_ID: 'dx472-de-prueba',
      EXCHANGE_BASE_URL: `http://127.0.0.1:${port}`,
    };

    app = await createE2eApp({
      override: (builder) =>
        builder
          .overrideProvider(EXCHANGE_RATE_PROVIDER)
          .useValue(
            new OpenExchangeRatesProvider({
              get: (key: string) => settings[key],
            } as unknown as ConfigService),
          )
          .overrideProvider(EXCHANGE_RATE_CLOCK)
          .useValue(() => new Date(Date.now() + clockOffsetMs)),
    });
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx472', REGIONAL_NEW_YORK_FIXTURE);
    const patient = await as(api().post('/api/v1/patients'))
      .send({
        firstName: 'Saldo',
        lastName: 'Único',
        docType: 'NATIONAL_ID',
        docNumber: 'DX472-001',
        sex: Sex.F,
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;
    const catalog = await as(api().post('/api/v1/catalog/items'))
      .send({
        code: 'DX472-RES',
        kind: 'PROCEDURE',
        labelEs: 'Resina',
        color: '#2A2B3C',
      })
      .expect(201);
    catalogItemId = (catalog.body as { id: string }).id;

    usd.id = await planWith('USD', 300, 100);
    await finance(usd.id, 300);
    await pay(usd.id, 50.25, 'USD');
    await pay(usd.id, 15000, 'JPY');

    jpy.id = await planWith('JPY', 20000, 999);
    await finance(jpy.id, 20000);
    await pay(jpy.id, 5000, 'JPY');
    await pay(jpy.id, 10, 'USD');

    // Cancelar con abonos ya no se puede: un plan así viene de antes.
    cancelled.id = await planWith('USD', 300, null);
    await finance(cancelled.id, 300);
    await pay(cancelled.id, 120, 'USD');
    await pay(cancelled.id, 1500, 'JPY');
    await raw.treatmentPlan.update({
      where: { id: cancelled.id },
      data: { status: 'CANCELLED' },
    });
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => provider.close(resolve));
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: [paidOn, legacyOn] } },
    });
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('plan USD con ítem PROPOSED y abono en JPY: la conversión cuenta en las tres', async () => {
    await expectSameFigures(usd.id, {
      billable: 300,
      paid: 150.25,
      balance: 149.75,
      rateProviderTimedOut: false,
    });
    const { statement } = await views(usd.id);
    const line = statement.plans.find((p) => p.id === usd.id);
    // Lo presupuestado y lo entregado, en campos aparte.
    expect(line).toMatchObject({
      budgeted: 300,
      paidOtherCurrencies: [{ currency: 'JPY', amount: 15000 }],
    });
  });

  it('plan JPY sin decimales con abono en USD', async () => {
    await expectSameFigures(jpy.id, {
      billable: 20000,
      paid: 6500,
      balance: 13500,
    });
  });

  it('plan CANCELLED con abonos: no debe nada y lo abonado queda a favor', async () => {
    await expectSameFigures(cancelled.id, {
      billable: 0,
      paid: 130,
      balance: -130,
    });
    const { statement } = await views(cancelled.id);
    expect(statement.plans.find((p) => p.id === cancelled.id)).toMatchObject({
      budgeted: 300,
    });
  });

  it('el resumen da lo entregado sin convertir y, aparte, lo que cuadra con los planes', async () => {
    const { statement } = await views(usd.id);
    expect(
      statement.summary.map(
        ({ currency, paid, convertedPaid, convertedBalance }) => ({
          currency,
          paid,
          convertedPaid,
          convertedBalance,
        }),
      ),
    ).toEqual([
      // Lo entregado: 5000 + 15000 + 1500 JPY y 50,25 + 10 + 120 USD.
      {
        currency: 'JPY',
        paid: 21500,
        convertedPaid: 6500,
        convertedBalance: 13500,
      },
      {
        currency: 'USD',
        paid: 180.25,
        convertedPaid: 280.25,
        convertedBalance: 19.75,
      },
    ]);
  });

  it('las cuotas del estado de cuenta son las de /payment-plan', async () => {
    const { statement, paymentPlan } = await views(usd.id);
    expect(
      statement.installments
        .filter((i) => i.treatmentPlanId === usd.id)
        .map(({ status, covered }) => ({ status, covered })),
    ).toEqual(
      paymentPlan.installments.map(({ status, covered }) => ({
        status,
        covered,
      })),
    );
    expect(paymentPlan.overdueCount).toBeGreaterThan(0);
  });

  describe('con el proveedor colgado', () => {
    let legacyId: string;

    beforeAll(async () => {
      legacyId = await pay(usd.id, 7500, 'JPY', legacyOn);
      // Anterior a DX-375 y sin base: solo se puede convertir en vivo.
      await raw.paymentAllocation.deleteMany({
        where: { paymentId: legacyId },
      });
      await raw.paymentPlanAmount.deleteMany({
        where: { paymentId: legacyId },
      });
      await raw.payment.update({
        where: { id: legacyId },
        data: {
          exchangeRateCurrency: null,
          exchangeRateFrom: null,
          exchangeRateTo: null,
          exchangeRateSource: null,
          exchangeRateDate: null,
        },
      });
      await raw.exchangeRateSnapshot.deleteMany({
        where: { date: legacyOn },
      });
      hanging = true;
    });

    afterAll(() => {
      hanging = false;
      for (const res of open) res.destroy();
      open.clear();
    });

    it('los tres responden 200 en menos de 6 s, avisan y no suman lo no convertido', async () => {
      const { elapsedMs, statuses, balance, statement, paymentPlan } =
        await views(usd.id);

      expect(statuses).toEqual([200, 200, 200]);
      expect(elapsedMs).toBeLessThan(TOO_SLOW_MS);
      // El proveedor recibió de verdad la petición y no contestó.
      expect(open.size).toBeGreaterThan(0);

      const expected = {
        billable: 300,
        paid: 150.25,
        balance: 149.75,
        rateProviderTimedOut: true,
        paymentsWithoutRate: [expect.objectContaining({ paymentId: legacyId })],
      };
      const line = statement.plans.find((p) => p.id === usd.id) as Figures;
      expect(picked(balance)).toEqual(expected);
      expect(picked(line)).toEqual(expected);
      expect(picked(paymentPlan)).toEqual(expected);
      expect(statement.rateProviderTimedOut).toBe(true);
    });

    it('ninguna cuota sale vencida por lo no convertido', async () => {
      const { paymentPlan, statement } = await views(usd.id);

      expect(paymentPlan.overdueCount).toBe(0);
      expect(paymentPlan.overdueAmount).toBe(0);
      const statuses = [
        ...paymentPlan.installments,
        ...statement.installments.filter((i) => i.treatmentPlanId === usd.id),
      ].map((i) => i.status);
      expect(statuses).not.toContain('OVERDUE');
      expect(statement.summary.find((s) => s.currency === 'USD')).toMatchObject(
        { overdueCount: 0 },
      );
    });

    it('agotada la llamada, sigue avisando (no pasa a «sin tasa») y ya no espera', async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, PROVIDER_TIMEOUT_MS + 500),
      );

      const { elapsedMs, balance, statement, paymentPlan } = await views(
        usd.id,
      );

      expect(elapsedMs).toBeLessThan(BALANCE_CONVERSION_BUDGET_MS);
      expect(balance.rateProviderTimedOut).toBe(true);
      expect(statement.rateProviderTimedOut).toBe(true);
      expect(paymentPlan.rateProviderTimedOut).toBe(true);
      expect(paymentPlan.overdueCount).toBe(0);
    }, 30_000);
  });

  it('cuando el proveedor vuelve, las tres se completan y lo vencido reaparece', async () => {
    clockOffsetMs += NOT_RESPONDING_NEGATIVE_TTL_MS;
    await expectSameFigures(usd.id, {
      billable: 300,
      paid: 200.25,
      balance: 99.75,
      rateProviderTimedOut: false,
      paymentsWithoutRate: [],
    });
    const { paymentPlan } = await views(usd.id);
    expect(paymentPlan.overdueCount).toBeGreaterThan(0);
  });
});
