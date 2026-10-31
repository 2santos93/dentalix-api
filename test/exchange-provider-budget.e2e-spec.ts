import { INestApplication } from '@nestjs/common';
import { CatalogKind, Prisma, PrismaClient, Sex } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  registerClinic,
  resetDatabase,
  type Clinic,
} from './support/e2e-fixtures';
import {
  EXCHANGE_RATE_PROVIDER,
  type ExchangeRatesResult,
} from '../src/modules/exchange/domain/ports/exchange-rate-provider.port';
import { DEFAULT_PROVIDER_RATES_LIMITS } from '../src/modules/exchange/application/provider-rates-gate';
import { PaymentAllocationJobs } from '../src/modules/payments/application/payment-allocation-jobs';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import { REGIONAL_BOGOTA_FIXTURE } from './support/location-fixtures';

// SEC-058 en HTTP real, con los topes por defecto y un doble del proveedor
// que cuenta sus llamadas (nunca sale a la red). Una clínica recién dada de
// alta registra un abono fechado en el año 2000 (abre su ventana de días) y
// pide días de ese año hasta agotar su tope de clínica nueva: 429 en español
// con Retry-After. Con el cupo agotado, un abono en otra moneda se guarda
// igual, pendiente de tasa (como con el proveedor caído, DX-380), y el
// barrido de reintentos le congela la tasa con su cupo reservado. Otra
// clínica sigue obteniendo tasa. `raw` (DIRECT_URL) solo observa y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const NEW_CLINIC_LIMIT = DEFAULT_PROVIDER_RATES_LIMITS.newClinic.limit;
const FIRST_DAY = '2000-01-03';
const ASKED_DAYS = Array.from({ length: 10 }, (_, i) =>
  addCivilDays('2000-01-04', i),
);
const PENDING_DAY = '2000-02-01';
const today = () => civilDateIn(new Date(), REGIONAL_BOGOTA_FIXTURE.timeZone);
const allDays = () => [FIRST_DAY, ...ASKED_DAYS, PENDING_DAY, today()];

interface ErrorBody {
  statusCode: number;
  code?: string;
  message: string;
}

describe('Cupo por clínica del proveedor de tasas (e2e, SEC-058)', () => {
  let app: INestApplication<App>;
  let attacker: Clinic;
  let other: Clinic;
  let planId: string;
  const fetchRates = jest.fn((date: string): Promise<ExchangeRatesResult> =>
    Promise.resolve({
      base: 'USD',
      rates: { COP: 4000 + Number(date.slice(-2)) },
    }),
  );

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, clinic: Clinic) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`);
  const rates = (clinic: Clinic, date: string) =>
    as(api().get(`/api/v1/exchange/rates?date=${date}`), clinic);
  const pay = (date: string) =>
    as(api().post(`/api/v1/treatment-plans/${planId}/payments`), attacker)
      .send({
        amount: 40000,
        currency: 'COP',
        paidAt: `${date}T15:00:00.000Z`,
        method: 'CASH',
      })
      .expect(201)
      .then((res) => res.body as { id: string; exchangeRateStatus: string });

  async function seedPlan(clinic: Clinic): Promise<string> {
    const patient = (
      await as(api().post('/api/v1/patients'), clinic)
        .send({
          firstName: 'Ana',
          lastName: 'Cupo',
          docType: 'NATIONAL_ID',
          docNumber: 'SEC058-1',
          sex: Sex.F,
        })
        .expect(201)
    ).body as { id: string };
    const item = (
      await as(api().post('/api/v1/catalog/items'), clinic)
        .send({
          code: 'SEC058-1',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Corona',
          color: '#2A2B3C',
          defaultPrice: 1000,
        })
        .expect(201)
    ).body as { id: string };
    const plan = (
      await as(
        api().post(`/api/v1/patients/${patient.id}/treatment-plans`),
        clinic,
      )
        .send({ notes: 'Plan SEC-058', currency: 'USD' })
        .expect(201)
    ).body as { id: string };
    await as(api().post(`/api/v1/treatment-plans/${plan.id}/items`), clinic)
      .send({ toothNumber: '11', catalogItemId: item.id })
      .expect(201);
    return plan.id;
  }

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) =>
        builder
          .overrideProvider(EXCHANGE_RATE_PROVIDER)
          .useValue({ fetchRates }),
    });
    await resetDatabase(raw);
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: allDays() } },
    });
    attacker = await registerClinic(app, 'sec058-attacker');
    other = await registerClinic(app, 'sec058-other');
    planId = await seedPlan(attacker);
  });

  afterAll(async () => {
    await raw.exchangeRateSnapshot.deleteMany({
      where: { date: { in: allDays() } },
    });
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('una clínica nueva agota su tope: 429 en español, el abono queda pendiente de tasa y el barrido la congela', async () => {
    // El abono del 2000 gasta la primera llamada y abre la ventana.
    const first = await pay(FIRST_DAY);
    expect(first.exchangeRateStatus).not.toBe('MISSING');
    expect(fetchRates).toHaveBeenCalledTimes(1);

    let served = 0;
    let limited: request.Response | undefined;
    for (const date of ASKED_DAYS) {
      const res = await rates(attacker, date);
      if (res.status !== 200) {
        limited = res;
        break;
      }
      served += 1;
    }
    expect(served).toBe(NEW_CLINIC_LIMIT - 1);
    expect(limited?.status).toBe(429);
    const body = limited!.body as ErrorBody;
    expect(body.code).toBe('EXCHANGE_RATE_BUDGET_EXCEEDED');
    expect(body.message).toMatch(
      /^La clínica consultó demasiados días sin tasa guardada\. Intenta de nuevo en /,
    );
    expect(Number(limited!.headers['retry-after'])).toBeGreaterThan(0);
    expect(fetchRates).toHaveBeenCalledTimes(NEW_CLINIC_LIMIT);

    // Con el cupo agotado, el abono se registra igual: pendiente de tasa,
    // sin llamar al proveedor, y entra en la lista del barrido.
    const pending = await pay(PENDING_DAY);
    expect(pending.exchangeRateStatus).toBe('MISSING');
    expect(fetchRates).toHaveBeenCalledTimes(NEW_CLINIC_LIMIT);
    expect(
      await raw.paymentBaseRetry.count({ where: { paymentId: pending.id } }),
    ).toBe(1);

    // El barrido gasta de su reserva (no del cupo agotado) y la congela.
    await app.get(PaymentAllocationJobs).sweep();
    expect(fetchRates).toHaveBeenLastCalledWith(PENDING_DAY);
    const frozen = await raw.payment.findUniqueOrThrow({
      where: { id: pending.id },
      select: { exchangeRateFrom: true },
    });
    expect(frozen.exchangeRateFrom).not.toBeNull();
    expect(
      await raw.paymentBaseRetry.count({ where: { paymentId: pending.id } }),
    ).toBe(0);

    // La otra clínica sigue obteniendo tasa.
    await rates(other, today()).expect(200);
  });
});
