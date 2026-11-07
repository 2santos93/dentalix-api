import { INestApplication } from '@nestjs/common';
import { CatalogKind, Prisma, PrismaClient, Sex } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { Clinic, registerClinic, resetDatabase } from './support/e2e-fixtures';
import { MANUAL_RATE_IN_USE_MESSAGE } from '../src/modules/exchange/domain/exchange-rate-source';
import { EXCHANGE_RATE_CLOCK } from '../src/modules/exchange/application/use-cases/manual-exchange-rates.use-cases';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { fixedSedeDay } from './support/sede-clock';
import {
  pauseAfterSql,
  reachedWithin,
  settle,
  sqlStop,
  waitForLockWaiters,
  waitingQueries,
} from './support/postgres-concurrency';
import { pinCatalogCurrency } from './support/catalog-currency';

// DX-397 (TST-048) contra Postgres: los dos candados de la tasa manual
// congelada (DX-375), con el solapamiento FORZADO, sin carreras de reloj.
//
//   alta de abono  -> manualRatesStillMatch (frozen-exchange-rate.mapper.ts):
//                     las tasas manuales del día FOR SHARE hasta el COMMIT.
//   corrección     -> correct (prisma-manual-exchange-rate.repository.ts):
//                     la fila FOR UPDATE y, en la misma transacción, mira si
//                     algún abono ya la usa.
//
// Cada caso para UNA de las dos transacciones justo después de tomar su
// candado (con su pid) y lanza la otra; sólo cuando Postgres dice que la
// segunda espera a ese pid se suelta la primera. EXCHANGE_APP_ID está vacío
// en .env.test: el proveedor no se llama nunca.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SEDE_DAY = fixedSedeDay();
const TODAY = SEDE_DAY.day;
const MANUAL_RATES = '/api/v1/exchange/manual-rates';

// Las sentencias de los dos candados, SIN la cláusula FOR: quitar el candado
// de producción deja el int en rojo por la espera que no llega, no colgado.
const READ_RATES_TO_FREEZE =
  /FROM "manual_exchange_rates"[\s\S]*"currency" = ANY/;
const LOCK_RATE_TO_CORRECT = /FROM "manual_exchange_rates"[\s\S]*"id" =/;

// Las transacciones pausadas viven más que la espera de 5 s del helper: con
// el tope por defecto (5 s) un runner lento las deshacería («Transaction
// already closed») antes de que falle la aserción del bloqueo.
process.env.TENANT_TX_TIMEOUT_MS = '30000';

describe('tasa manual congelada: alta de abono frente a corrección (DX-397, int)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let clinic: Clinic;
  let planId: string;
  let undo: (() => void) | null = null;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`);

  /** Una tasa manual de hoy; cada caso usa una moneda propia. */
  async function registerRate(currency: string, rate: number) {
    return (
      await as(api().post(MANUAL_RATES))
        .send({ date: TODAY, currency, rate })
        .expect(201)
    ).body as { id: string };
  }

  const correct = (id: string, rate: number) =>
    as(api().put(`${MANUAL_RATES}/${id}`)).send({ rate });

  const pay = (currency: string, amount: number) =>
    as(api().post(`/api/v1/treatment-plans/${planId}/payments`)).send({
      amount,
      currency,
      paidAt: SEDE_DAY.before(60).toISOString(),
      method: 'CASH',
    });

  const rateOf = async (id: string) =>
    Number(
      (await raw.manualExchangeRate.findUniqueOrThrow({ where: { id } })).rate,
    );

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) =>
        builder
          .overrideProvider(EXCHANGE_RATE_CLOCK)
          .useValue(() => SEDE_DAY.at),
    });
    prisma = app.get(PrismaService);
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx397-rate');
    await as(api().put('/api/v1/exchange/settings'))
      .send({ source: 'MANUAL' })
      .expect(200);

    const patient = (
      await as(api().post('/api/v1/patients'))
        .send({
          firstName: 'Ana',
          lastName: 'Congelada',
          docType: 'NATIONAL_ID',
          docNumber: 'DX397-R',
          sex: Sex.F,
        })
        .expect(201)
    ).body as { id: string };
    // DX-513-bis: el catálogo en la moneda de los planes del spec (USD): sus
    // ítems no necesitan tasa y sus importes no cambian (support/catalog-currency).
    await pinCatalogCurrency(raw, clinic.tenantId, 'USD');
    const catalogItem = (
      await as(api().post('/api/v1/catalog/items'))
        .send({
          code: 'DX397-R',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Corona',
          color: '#2A2B3C',
          defaultPrice: 1000,
        })
        .expect(201)
    ).body as { id: string };
    planId = (
      (
        await as(api().post(`/api/v1/patients/${patient.id}/treatment-plans`))
          .send({ notes: 'Plan DX-397', currency: 'USD' })
          .expect(201)
      ).body as { id: string }
    ).id;
    const item = (
      await as(api().post(`/api/v1/treatment-plans/${planId}/items`))
        .send({ toothNumber: '11', catalogItemId: catalogItem.id })
        .expect(201)
    ).body as { id: string };
    await as(api().patch(`/api/v1/treatment-plans/${planId}/items/${item.id}`))
      .send({ status: 'DONE' })
      .expect(200);
  });

  afterEach(() => {
    undo?.();
    undo = null;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('alta de abono a medias: la corrección de la tasa espera a su COMMIT y responde 409', async () => {
    const rate = await registerRate('VES', 40);
    const inPayment = sqlStop(READ_RATES_TO_FREEZE);
    undo = pauseAfterSql(prisma, [inPayment]);

    // El abono congela la VES 40 y se queda con las tasas FOR SHARE.
    const paying = settle(pay('VES', 400));
    const payingPid = await reachedWithin(inPayment, paying, 'abono');

    // Una corrección que llega a medias: espera al pid del abono.
    const correcting = settle(correct(rate.id, 45));
    try {
      await waitForLockWaiters(raw, [payingPid]);
      // Espera en el FOR UPDATE de correct() (su primera sentencia), no en
      // el UPDATE ni en el trigger de la BD: sin ese FOR UPDATE la
      // corrección pasaría por usedRateKeys, esperaría después en el UPDATE y
      // el trigger la dejaría también en 409 (eso lo fija el otro caso).
      expect(await waitingQueries(raw, [payingPid])).toEqual([
        expect.stringMatching(/FOR UPDATE/),
      ]);
      await expect(rateOf(rate.id)).resolves.toBe(40);
    } finally {
      inPayment.release.open();
    }
    const payment = await paying;
    const correction = await correcting;

    expect(payment).toMatchObject({
      status: 'fulfilled',
      value: { status: 201 },
    });
    const body = (payment as { value: { body: Record<string, unknown> } }).value
      .body;
    expect(body).toMatchObject({
      exchangeRateStatus: 'FROZEN',
      frozenRate: { source: 'MANUAL', fromPerBase: 40 },
    });
    // La corrección vio el abono ya confirmado: 409 y la tasa sigue en 40.
    expect(correction).toMatchObject({
      status: 'fulfilled',
      value: {
        status: 409,
        body: {
          code: 'MANUAL_EXCHANGE_RATE_IN_USE',
          message: MANUAL_RATE_IN_USE_MESSAGE,
        },
      },
    });
    await expect(rateOf(rate.id)).resolves.toBe(40);
  });

  it('corrección a medias: el alta del abono espera, ve la tasa nueva y queda «sin tasa» en vez de congelar la vieja', async () => {
    const rate = await registerRate('EUR', 0.9);
    const inCorrection = sqlStop(LOCK_RATE_TO_CORRECT);
    undo = pauseAfterSql(prisma, [inCorrection]);

    // La corrección tiene la fila FOR UPDATE y aún no ha escrito la nueva.
    const correcting = settle(correct(rate.id, 0.95));
    const correctingPid = await reachedWithin(
      inCorrection,
      correcting,
      'corrección',
    );

    // El abono cotiza la tasa vieja (0,9) y espera a la fila en su FOR SHARE.
    const paying = settle(pay('EUR', 90));
    try {
      await waitForLockWaiters(raw, [correctingPid]);
    } finally {
      inCorrection.release.open();
    }
    const correction = await correcting;
    const payment = await paying;

    expect(correction).toMatchObject({
      status: 'fulfilled',
      value: { status: 200, body: { rate: 0.95 } },
    });
    await expect(rateOf(rate.id)).resolves.toBe(0.95);
    expect(payment).toMatchObject({
      status: 'fulfilled',
      value: { status: 201 },
    });
    const body = (
      payment as {
        value: { body: { id: string; exchangeRateStatus: string } };
      }
    ).value.body;
    // Nunca queda congelada una tasa que ya no existe.
    expect(body.exchangeRateStatus).toBe('MISSING');
    await expect(
      raw.payment.findUniqueOrThrow({
        where: { id: body.id },
        select: { exchangeRateSource: true, exchangeRateFrom: true },
      }),
    ).resolves.toEqual({ exchangeRateSource: null, exchangeRateFrom: null });
    await expect(
      raw.paymentPlanAmount.count({ where: { paymentId: body.id } }),
    ).resolves.toBe(0);
  });
});
