import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient, Sex } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { ConfigService } from '@nestjs/config';
import { EXCHANGE_RATE_PROVIDER } from '../src/modules/exchange/domain/ports/exchange-rate-provider.port';
import { OpenExchangeRatesProvider } from '../src/modules/exchange/infrastructure/providers/open-exchange-rates.provider';
import { NOT_RESPONDING_NEGATIVE_TTL_MS } from '../src/modules/exchange/application/provider-rates-gate';
import { EXCHANGE_RATE_CLOCK } from '../src/modules/exchange/application/use-cases/manual-exchange-rates.use-cases';
import { createE2eApp } from './support/create-e2e-app';
import { fixedSedeDay } from './support/sede-clock';
import {
  registerClinic,
  resetDatabase,
  type Clinic,
} from './support/e2e-fixtures';

// DX-472-bis: el estado de cuenta, la cartera (GET /receivables/aging), el
// chip «Saldo vencido» de la ficha (GET /patients/:id, `balance`) y el
// selector de cobro (GET /patients/:id/billable-plans) dan la MISMA cifra para
// el mismo plan cuando se abona en otra moneda. Clínica en Caracas, planes en
// USD con abonos en bolívares a tasa 36 (y uno en JPY). El proveedor de tasas
// es el de verdad (OpenExchangeRatesProvider) contra un servidor HTTP de
// prueba que responde o se queda colgado. `raw` (DIRECT_URL) deja abonos como
// los deja el pasado: «sin tasa» o anteriores a DX-375 sin congelar.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const RATES = { VES: 36, JPY: 150 };
const TOO_SLOW_MS = 6_000;

interface StatementPlan {
  id: string;
  balance: number;
  paid: number;
  paymentsWithoutRate: { paymentId: string }[];
  rateProviderTimedOut: boolean;
}
interface StatementBody {
  rateProviderTimedOut: boolean;
  plans: StatementPlan[];
  summary: {
    currency: string;
    convertedBalance: number;
    overdueCount: number;
    overdueAmount: number;
  }[];
}
interface AgingCurrency {
  currency: string;
  balance: number;
  debt: number;
  credit: number;
  buckets: Record<string, number>;
  oldestAgeDays: number | null;
}
interface AgingRow {
  patient: { id: string };
  currencies: AgingCurrency[];
  oldestAgeDays: number | null;
  paymentsWithoutRateCount: number;
  rateProviderTimedOut: boolean;
}
interface AgingPage {
  items: AgingRow[];
  totals: { currency: string; balance: number; debt: number }[];
  paymentsWithoutRateCount: number;
  rateProviderTimedOut: boolean;
}
interface Chip {
  hasOverdue: boolean;
  overdueDays: number | null;
  amounts?: { currency: string; amount: number }[];
  incomplete?: true;
}
interface BillablePlan {
  id: string;
  paid: number;
  balance: number;
  paymentsWithoutRate: { paymentId: string }[];
  rateProviderTimedOut: boolean;
}

describe('DX-472-bis: mismas cifras convertidas en estado de cuenta, cartera, chip y selector de cobro (e2e)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let catalogItemId: string;
  let provider: Server;
  let hanging = false;
  const open = new Set<ServerResponse>();
  const sockets = new Set<Socket>();
  let clockOffsetMs = 0;

  const paidOn = fixedSedeDay(3).day;
  const legacyOn = fixedSedeDay(5).day;
  // B4: el día en que 1 USD = 149,9987 JPY, así USD 100 son ¥14.999,87.
  const residueOn = fixedSedeDay(6).day;
  // Cuotas con vencimientos ya pasados: si el abono no contara, saldrían vencidas.
  const start = fixedSedeDay(70).day;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, who: Clinic = clinic) =>
    req
      .set('X-Tenant-Host', who.host)
      .set('Authorization', `Bearer ${who.adminToken}`);

  async function newPatient(name: string): Promise<string> {
    const res = await as(api().post('/api/v1/patients'))
      .send({
        firstName: name,
        lastName: 'Cartera',
        docType: 'NATIONAL_ID',
        docNumber: `V-472${Math.floor(Math.random() * 1e6)}`,
        sex: Sex.F,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function planWith(
    patientId: string,
    currency: string,
    accepted: number,
  ): Promise<string> {
    const plan = await as(
      api().post(`/api/v1/patients/${patientId}/treatment-plans`),
    )
      .send({ currency })
      .expect(201);
    const id = (plan.body as { id: string }).id;
    const item = await as(api().post(`/api/v1/treatment-plans/${id}/items`))
      .send({ toothNumber: '11', catalogItemId, price: accepted })
      .expect(201);
    await as(
      api().patch(
        `/api/v1/treatment-plans/${id}/items/${(item.body as { id: string }).id}`,
      ),
    )
      .send({ status: 'ACCEPTED' })
      .expect(200);
    return id;
  }

  const finance = (planId: string, totalToFinance: number) =>
    as(api().post(`/api/v1/treatment-plans/${planId}/payment-plan`))
      .send({
        totalToFinance,
        installmentsCount: 2,
        periodicity: 'MONTHLY',
        startDate: start,
      })
      .expect(201);

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

  /** Deja el abono sin base ni imputación (como antes de su barrido). */
  async function withoutBase(paymentId: string) {
    await raw.paymentAllocation.deleteMany({ where: { paymentId } });
    await raw.paymentPlanAmount.deleteMany({ where: { paymentId } });
  }

  /** Las cuatro vistas del paciente, a la vez, como las pide la web. */
  async function views(patientId: string) {
    const started = Date.now();
    const [statement, aging, patient, billable] = await Promise.all([
      as(api().get(`/api/v1/patients/${patientId}/account-statement`)),
      as(api().get('/api/v1/receivables/aging?pageSize=100')),
      as(api().get(`/api/v1/patients/${patientId}`)),
      as(api().get(`/api/v1/patients/${patientId}/billable-plans`)),
    ]);
    const page = aging.body as AgingPage;
    return {
      elapsedMs: Date.now() - started,
      statuses: [
        statement.status,
        aging.status,
        patient.status,
        billable.status,
      ],
      statement: statement.body as StatementBody,
      page,
      row: page.items.find((r) => r.patient.id === patientId),
      chip: (patient.body as { balance: Chip }).balance,
      billable: billable.body as BillablePlan[],
    };
  }

  const usdOf = (row: AgingRow | undefined) =>
    row?.currencies.find((c) => c.currency === 'USD');

  beforeAll(async () => {
    provider = createServer((req, res) => {
      if (hanging) {
        open.add(res);
        return;
      }
      res.setHeader('content-type', 'application/json');
      const rates = req.url?.includes(residueOn)
        ? { ...RATES, JPY: 149.9987 }
        : RATES;
      res.end(JSON.stringify({ base: 'USD', rates }));
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
      EXCHANGE_APP_ID: 'dx472bis-de-prueba',
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
    clinic = await registerClinic(app, 'dx472bis');
    other = await registerClinic(app, 'dx472bis-otra');
    const catalog = await as(api().post('/api/v1/catalog/items'))
      .send({
        code: 'DX472B-RES',
        kind: 'PROCEDURE',
        labelEs: 'Resina',
        color: '#2A2B3C',
      })
      .expect(201);
    catalogItemId = (catalog.body as { id: string }).id;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => provider.close(resolve));
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: [paidOn, legacyOn, residueOn] } },
    });
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('USD 100 pagado con Bs 3.600 a tasa 36: saldo 0 en las cuatro, sin cartera, sin chip y sin bolívares a favor', async () => {
    const patientId = await newPatient('Saldada');
    const planId = await planWith(patientId, 'USD', 100);
    await finance(planId, 100);
    await pay(planId, 3600, 'VES');

    const { statuses, statement, row, chip, billable } = await views(patientId);
    expect(statuses).toEqual([200, 200, 200, 200]);
    expect(statement.plans.find((p) => p.id === planId)).toMatchObject({
      paid: 100,
      balance: 0,
    });
    expect(
      statement.summary.find((s) => s.currency === 'USD')?.convertedBalance,
    ).toBe(0);
    // Antes: USD 100 por cobrar y Bs 3.600 a favor.
    expect(row).toBeUndefined();
    expect(chip).toEqual({ hasOverdue: false, overdueDays: null });
    expect(billable.find((p) => p.id === planId)).toMatchObject({
      paid: 100,
      balance: 0,
      paymentsWithoutRate: [],
      rateProviderTimedOut: false,
    });
  });

  it('abono parcial en bolívares: la deuda de la cartera, el chip y el selector son el saldo del estado de cuenta', async () => {
    const patientId = await newPatient('Parcial');
    const planId = await planWith(patientId, 'USD', 300);
    await finance(planId, 300);
    await pay(planId, 3600, 'VES');

    const { statement, row, chip, billable } = await views(patientId);
    const line = statement.plans.find((p) => p.id === planId);
    expect(line).toMatchObject({ paid: 100, balance: 200 });
    const usd = statement.summary.find((s) => s.currency === 'USD');
    expect(usd?.convertedBalance).toBe(200);

    expect(row?.currencies.map((c) => c.currency)).toEqual(['USD']);
    expect(usdOf(row)).toMatchObject({ balance: 200, debt: 200, credit: 0 });
    expect(chip.hasOverdue).toBe(true);
    // Lo vencido del chip es lo vencido del estado de cuenta.
    expect(chip.amounts).toEqual([
      { currency: 'USD', amount: usd?.overdueAmount },
    ]);
    expect(billable.find((p) => p.id === planId)).toMatchObject({
      paid: 100,
      balance: line?.balance,
    });
  });

  it('plan JPY sin decimales con abono en USD', async () => {
    const patientId = await newPatient('Yenes');
    const planId = await planWith(patientId, 'JPY', 20000);
    await pay(planId, 10, 'USD');

    const { statement, row, billable } = await views(patientId);
    expect(statement.plans.find((p) => p.id === planId)).toMatchObject({
      paid: 1500,
      balance: 18500,
    });
    expect(row?.currencies).toEqual([
      expect.objectContaining({
        currency: 'JPY',
        balance: 18500,
        debt: 18500,
        credit: 0,
      }),
    ]);
    expect(billable.find((p) => p.id === planId)).toMatchObject({
      paid: 1500,
      balance: 18500,
    });
  });

  it('plan CANCELLED con abono en bolívares: lo abonado queda a favor en USD, como en el estado de cuenta', async () => {
    const patientId = await newPatient('Cancelada');
    const cancelled = await planWith(patientId, 'USD', 300);
    await pay(cancelled, 3600, 'VES');
    // Cancelar con abonos ya no se puede: un plan así viene de antes.
    await raw.treatmentPlan.update({
      where: { id: cancelled },
      data: { status: 'CANCELLED' },
    });
    const owing = await planWith(patientId, 'USD', 50);

    const { statement, row, billable } = await views(patientId);
    expect(statement.plans.find((p) => p.id === cancelled)).toMatchObject({
      paid: 100,
      balance: -100,
    });
    const usd = statement.summary.find((s) => s.currency === 'USD');
    expect(usd?.convertedBalance).toBe(-50);
    // Antes: Bs 3.600 a favor y USD 50 por cobrar.
    expect(row?.currencies.map((c) => c.currency)).toEqual(['USD']);
    expect(usdOf(row)).toMatchObject({ debt: 50, credit: 100, balance: -50 });
    // Un plan cancelado no se cobra; el otro, sí.
    expect(billable.map((p) => p.id)).toEqual([owing]);
  });

  it('abono «sin tasa»: no suma en ninguna vista, se avisa en todas y sus cuotas pasadas siguen vencidas', async () => {
    const patientId = await newPatient('Sintasa');
    const planId = await planWith(patientId, 'USD', 100);
    await finance(planId, 100);
    const paymentId = await pay(planId, 3600, 'VES');
    await withoutBase(paymentId);
    await raw.payment.update({
      where: { id: paymentId },
      data: {
        exchangeRateCurrency: 'USD',
        exchangeRateFrom: null,
        exchangeRateTo: null,
        exchangeRateSource: null,
        exchangeRateDate: null,
      },
    });

    const { statement, row, chip, billable, page } = await views(patientId);
    const line = statement.plans.find((p) => p.id === planId);
    expect(line).toMatchObject({ paid: 0, balance: 100 });
    expect(line?.paymentsWithoutRate).toEqual([
      expect.objectContaining({ paymentId }),
    ]);
    expect(usdOf(row)).toMatchObject({ debt: 100, credit: 0 });
    expect(row).toMatchObject({
      paymentsWithoutRateCount: 1,
      rateProviderTimedOut: false,
    });
    expect(page.paymentsWithoutRateCount).toBeGreaterThanOrEqual(1);
    // Falta la tasa de verdad (no es el proveedor): vencido, como en DX-472.
    expect(
      statement.summary.find((s) => s.currency === 'USD')?.overdueCount,
    ).toBeGreaterThan(0);
    expect(chip.hasOverdue).toBe(true);
    expect(billable.find((p) => p.id === planId)).toMatchObject({
      paid: 0,
      balance: 100,
      paymentsWithoutRate: [expect.objectContaining({ paymentId })],
      rateProviderTimedOut: false,
    });
  });

  it('saldo a favor de un abono en bolívares: se traspasa lo que muestra el estado de cuenta', async () => {
    const patientId = await newPatient('Favor');
    const origin = await planWith(patientId, 'USD', 100);
    await pay(origin, 7200, 'VES');
    const target = await planWith(patientId, 'USD', 50);

    const before = await views(patientId);
    expect(before.statement.plans.find((p) => p.id === origin)).toMatchObject({
      balance: -100,
    });

    // Antes de DX-472-bis: 400, el saldo a favor contaba solo lo abonado en USD.
    await as(api().post(`/api/v1/treatment-plans/${origin}/credit-transfers`))
      .set('Idempotency-Key', '472b0000-0000-4000-8000-000000000001')
      .send({ targetPlanId: target, amount: 100, currency: 'USD' })
      .expect(201);
    await as(api().post(`/api/v1/treatment-plans/${origin}/credit-transfers`))
      .set('Idempotency-Key', '472b0000-0000-4000-8000-000000000002')
      .send({ targetPlanId: target, amount: 0.01, currency: 'USD' })
      .expect(400);

    const after = await views(patientId);
    expect(
      after.statement.plans.map(({ id, balance }) => ({ id, balance })),
    ).toEqual(
      expect.arrayContaining([
        { id: origin, balance: 0 },
        { id: target, balance: -50 },
      ]),
    );
    expect(after.billable.find((p) => p.id === target)).toMatchObject({
      balance: -50,
    });
  });

  it('B4: plan JPY cubierto con USD que convierten a ¥14.999,87: ninguna cuota vencida de ¥0 en ninguna vista', async () => {
    const patientId = await newPatient('Residuo');
    const planId = await planWith(patientId, 'JPY', 15000);
    await finance(planId, 15000);
    await pay(planId, 100, 'USD', residueOn);

    const { statement, row, chip, billable } = await views(patientId);
    // El residuo es real en las cifras (2 decimales), pero no es deuda en yenes.
    expect(statement.plans.find((p) => p.id === planId)).toMatchObject({
      paid: 14999.87,
      balance: 0.13,
    });
    const jpy = statement.summary.find((s) => s.currency === 'JPY');
    expect(jpy).toMatchObject({ overdueCount: 0, overdueAmount: 0 });
    const paymentPlan = (
      await as(
        api().get(`/api/v1/treatment-plans/${planId}/payment-plan`),
      ).expect(200)
    ).body as {
      overdueCount: number;
      isFullyPaid: boolean;
      installments: { status: string }[];
    };
    expect(paymentPlan.installments.map((i) => i.status)).toEqual([
      'PAID',
      'PAID',
    ]);
    expect(paymentPlan).toMatchObject({ overdueCount: 0, isFullyPaid: true });
    expect(row).toBeUndefined();
    expect(chip).toEqual({ hasOverdue: false, overdueDays: null });
    expect(billable.find((p) => p.id === planId)).toMatchObject({
      balance: 0.13,
    });
  });

  it('revisión B1: una base en otra moneda que la del plan no cuenta en ninguna vista ni en el saldo a favor', async () => {
    const patientId = await newPatient('Basemala');
    const planId = await planWith(patientId, 'USD', 100);
    const target = await planWith(patientId, 'USD', 50);
    const paymentId = await pay(planId, 3600, 'VES');
    // Una base que no está en la moneda del plan (hoy no la crea la API: la
    // moneda del plan se bloquea con abonos; la BD no lo impide).
    await withoutBase(paymentId);
    const [payment] = await raw.$queryRaw<
      { tenantId: string; treatmentPlanId: string; paidAt: Date }[]
    >`SELECT "tenantId", "treatmentPlanId", "paidAt" FROM "payments" WHERE "id" = ${paymentId}::uuid`;
    await raw.paymentPlanAmount.create({
      data: {
        paymentId,
        tenantId: payment.tenantId,
        treatmentPlanId: payment.treatmentPlanId,
        amount: 3600,
        currency: 'VES',
        rateDate: payment.paidAt,
      },
    });

    const { statement, row, chip, billable } = await views(patientId);
    // Cuenta por su tasa congelada (36): USD 100, no «USD 3.600».
    expect(statement.plans.find((p) => p.id === planId)).toMatchObject({
      paid: 100,
      balance: 0,
    });
    expect(usdOf(row)).toMatchObject({ debt: 50, credit: 0 });
    expect(chip.hasOverdue).toBe(false);
    expect(billable.find((p) => p.id === planId)).toMatchObject({
      paid: 100,
      balance: 0,
    });
    // Sin saldo a favor que traspasar (con la base mala serían USD 3.500), y
    // el 400 dice por qué (revisión B3): el abono aún no cuenta.
    const refused = await as(
      api().post(`/api/v1/treatment-plans/${planId}/credit-transfers`),
    )
      .set('Idempotency-Key', '472b0000-0000-4000-8000-0000000000b1')
      .send({ targetPlanId: target, amount: 1, currency: 'USD' })
      .expect(400);
    expect((refused.body as { message: string }).message).toBe(
      'El importe supera el saldo a favor del plan. 1 abono en otra moneda todavía no cuenta en el saldo a favor: se suma en unos minutos, cuando quede registrada la tasa de su día. Vuelve a intentarlo después.',
    );
  });

  it('otra clínica no ve esta cartera', async () => {
    const res = await as(
      api().get('/api/v1/receivables/aging?pageSize=100'),
      other,
    ).expect(200);
    expect((res.body as AgingPage).items).toEqual([]);
  });

  describe('con el proveedor colgado y un abono anterior a DX-375', () => {
    let patientId: string;
    let planId: string;
    let legacyId: string;
    let settledId: string;
    // La agenda del día de su cita, en la zona de la sede.
    const visitDay = fixedSedeDay(-2);

    beforeAll(async () => {
      settledId = await newPatient('Congelada');
      const settledPlan = await planWith(settledId, 'USD', 100);
      await finance(settledPlan, 100);
      await pay(settledPlan, 3600, 'VES');

      patientId = await newPatient('Colgada');
      planId = await planWith(patientId, 'USD', 100);
      await finance(planId, 100);
      legacyId = await pay(planId, 3600, 'VES', legacyOn);
      // Anterior a DX-375 y sin base: solo se puede convertir en vivo.
      await withoutBase(legacyId);
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
      await raw.exchangeRateSnapshot.deleteMany({ where: { date: legacyOn } });
      await as(api().post('/api/v1/appointments'))
        .send({
          patientId,
          providerId: clinic.adminUserId,
          start: visitDay.at.toISOString(),
          end: new Date(visitDay.at.getTime() + 30 * 60_000).toISOString(),
        })
        .expect(201);
      hanging = true;
    });

    afterAll(() => {
      hanging = false;
      for (const res of open) res.destroy();
      open.clear();
    });

    it('las cuatro responden 200 en menos de 6 s, avisan, no suman lo no convertido y nada sale vencido', async () => {
      const { elapsedMs, statuses, statement, row, page, chip, billable } =
        await views(patientId);

      expect(statuses).toEqual([200, 200, 200, 200]);
      expect(elapsedMs).toBeLessThan(TOO_SLOW_MS);
      // El proveedor recibió de verdad la petición y no contestó.
      expect(open.size).toBeGreaterThan(0);

      const line = statement.plans.find((p) => p.id === planId);
      expect(line).toMatchObject({
        paid: 0,
        balance: 100,
        rateProviderTimedOut: true,
      });
      expect(statement.rateProviderTimedOut).toBe(true);
      expect(
        statement.summary.find((s) => s.currency === 'USD')?.overdueCount,
      ).toBe(0);

      // Cartera: la deuda incompleta va a «por vencer», nunca a vencida.
      expect(row).toMatchObject({
        rateProviderTimedOut: true,
        paymentsWithoutRateCount: 1,
        oldestAgeDays: null,
      });
      expect(usdOf(row)).toMatchObject({ debt: 100, oldestAgeDays: null });
      expect(usdOf(row)?.buckets).toMatchObject({
        current: 100,
        days0to30: 0,
        days31to60: 0,
      });
      expect(page.rateProviderTimedOut).toBe(true);
      expect(chip).toEqual({
        hasOverdue: false,
        overdueDays: null,
        incomplete: true,
      });

      expect(billable.find((p) => p.id === planId)).toMatchObject({
        paid: 0,
        balance: 100,
        rateProviderTimedOut: true,
        paymentsWithoutRate: [expect.objectContaining({ paymentId: legacyId })],
      });
    });

    it('revisión M1: la agenda no espera al proveedor (no convierte en vivo) y su marca dice «incompleto»', async () => {
      const started = Date.now();
      const res = await as(
        api().get(
          `/api/v1/appointments?from=${encodeURIComponent(
            visitDay.before(12 * 3600).toISOString(),
          )}&to=${encodeURIComponent(
            new Date(visitDay.at.getTime() + 12 * 3600_000).toISOString(),
          )}`,
        ),
      ).expect(200);
      expect(Date.now() - started).toBeLessThan(1_500);
      const visit = (res.body as { patientId: string; balance: Chip }[]).find(
        (a) => a.patientId === patientId,
      );
      expect(visit?.balance).toEqual({
        hasOverdue: false,
        overdueDays: null,
        incomplete: true,
      });
    });

    it('un abono con tasa congelada no depende del proveedor: sigue saldado en la cartera', async () => {
      const { row, chip } = await views(settledId);
      expect(row).toBeUndefined();
      expect(chip.hasOverdue).toBe(false);
    });

    it('cuando el proveedor vuelve, las cuatro se completan', async () => {
      hanging = false;
      for (const res of open) res.destroy();
      open.clear();
      // Las llamadas cortadas terminan de fallar y alargan la espera del
      // proveedor (DX-472, M1: 60 s que se doblan); se deja pasar de sobra.
      await new Promise((resolve) => setTimeout(resolve, 500));
      clockOffsetMs += 10 * NOT_RESPONDING_NEGATIVE_TTL_MS;

      const { statement, row, chip, billable } = await views(patientId);
      expect(statement.plans.find((p) => p.id === planId)).toMatchObject({
        paid: 100,
        balance: 0,
        rateProviderTimedOut: false,
      });
      expect(row).toBeUndefined();
      expect(chip.hasOverdue).toBe(false);
      expect(billable.find((p) => p.id === planId)).toMatchObject({
        balance: 0,
        rateProviderTimedOut: false,
      });
    });
  });
});
